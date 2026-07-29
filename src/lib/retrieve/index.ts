import { config } from "../config.ts";
import { db, toVectorLiteral } from "../db/client.ts";
import { embedQueries, rerank } from "../embed/index.ts";
import { rewriteQuery } from "./rewrite.ts";

export interface RetrievedChunk {
  readonly id: number;
  readonly docId: number;
  readonly sourcePath: string;
  readonly docTitle: string;
  readonly headingPath: string | null;
  readonly content: string;
  /** 코사인 거리(작을수록 유사). pgvector `<=>` 결과 그대로. */
  readonly distance: number;
  /** 리랭커 점수. 리랭킹을 끄면 undefined. */
  readonly rerankScore?: number;
}

export interface RetrieveOptions {
  readonly topK?: number;
  readonly topN?: number;
  /** eval 의 before/after 비교가 이 스위치로 나온다 (D3). */
  readonly rerankEnabled?: boolean;
  /** 키워드 검색을 섞을지. 리랭킹 스위치와 같은 이유로 남겨둔다 — 효과를 측정할 수 있어야 한다. */
  readonly hybridEnabled?: boolean;
  /** 질의를 LLM 으로 재작성해 여러 개로 검색할지 (rewrite.ts). */
  readonly rewriteEnabled?: boolean;
}

/**
 * Reciprocal Rank Fusion.
 *
 * 두 검색의 **점수**를 직접 더할 수는 없다 — 코사인 거리와 `ts_rank_cd` 는 척도가 다르고,
 * 정규화하려 들면 질의마다 분포가 달라 튜닝이 끝나지 않는다. RRF 는 점수를 버리고
 * **순위만** 쓴다: 어느 쪽에서든 위에 있으면 이긴다.
 *
 * k=60 은 원 논문(Cormack et al., 2009)의 값이고, 상수를 흔드는 것보다
 * 두 검색기 자체를 고치는 편이 이득이 크다.
 */
const RRF_K = 60;

function fuseByRank(rankings: readonly (readonly number[])[]): number[] {
  const score = new Map<number, number>();
  for (const ranking of rankings) {
    for (const [i, id] of ranking.entries()) {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export interface RetrieveTrace {
  readonly query: string;
  readonly topK: number;
  readonly topN: number;
  readonly rerankEnabled: boolean;
  readonly hybridEnabled: boolean;
  readonly rewriteEnabled: boolean;
  /**
   * 실제로 검색에 쓴 질의들. 재작성을 끄면 `[원문]` 하나뿐이다.
   * 재작성이 무엇을 했는지 눈으로 볼 수 있어야 그 기법을 신뢰할지 판단할 수 있다.
   */
  readonly queries: readonly string[];
  /** 재작성 호출/파싱이 실패해 원문만 남았는지. 조용히 넘어가지 않기 위한 필드다. */
  readonly rewriteFailed: boolean;
  /** 재작성을 캐시에서 읽었는지. true 면 아래 지연시간·토큰은 **최초 호출 때의 실측값**이다. */
  readonly rewriteFromCache: boolean;
  /**
   * 벡터 검색 순서 — **원문 질의 기준**이다. 재작성을 켜도 이 값의 의미는 바뀌지 않는다:
   * "재작성 없이 순수 벡터 검색만 했다면 무엇이 나왔을 것인가". 융합 후 순서는 `finalOrder`.
   */
  readonly vectorOrder: readonly number[];
  /** 키워드 검색 순서(원문 질의 기준). 하이브리드를 끄면 빈 배열. */
  readonly keywordOrder: readonly number[];
  readonly finalOrder: readonly number[];
  readonly ms: { rewrite: number; embed: number; vector: number; keyword: number; rerank: number };
  /** 재작성 호출의 토큰 사용량. 비용을 추정하지 않고 실측하기 위한 값이다. */
  readonly rewriteTokens: { input: number; output: number };
}

export interface RetrieveResponse {
  readonly chunks: readonly RetrievedChunk[];
  readonly trace: RetrieveTrace;
}

const CHUNK_COLUMNS = `c.id, c.doc_id, d.source_path, d.title, c.heading_path, c.content`;

interface ChunkRow {
  id: string;
  doc_id: string;
  source_path: string;
  title: string;
  heading_path: string | null;
  content: string;
  distance: number | null;
}

function toChunk(r: ChunkRow): RetrievedChunk {
  return {
    id: Number(r.id),
    docId: Number(r.doc_id),
    sourcePath: r.source_path,
    docTitle: r.title,
    headingPath: r.heading_path,
    content: r.content,
    distance: r.distance === null ? Number.NaN : Number(r.distance),
  };
}

/**
 * 키워드 검색.
 *
 * 질의어를 **OR 로 묶는다.** `websearch_to_tsquery` 는 기본이 AND 라서 자연어 문장을 그대로 주면
 * 모든 낱말을 포함한 청크만 남고, 대개 0건이 된다 — "My sorts keep spilling to disk. Which
 * setting caps that memory?" 를 전부 담은 문단은 없다. lexeme 을 뽑아 OR 로 잇고
 * `ts_rank_cd` 로 순위를 매기면, 드문 낱말(VACUUM, work_mem)이 자연히 점수를 지배한다.
 */
async function keywordSearch(query: string, limit: number): Promise<RetrievedChunk[]> {
  const res = await db().query<ChunkRow>(
    `WITH q AS (
       SELECT array_to_string(ARRAY(SELECT lexeme FROM unnest(to_tsvector('english', $1))), ' | ') AS raw
     )
     SELECT ${CHUNK_COLUMNS}, NULL::float8 AS distance
       FROM chunks c
       JOIN documents d ON d.id = c.doc_id, q
      WHERE q.raw <> '' AND c.fts @@ q.raw::tsquery
      ORDER BY ts_rank_cd(c.fts, q.raw::tsquery) DESC
      LIMIT $2`,
    [query, limit],
  );
  return res.rows.map(toChunk);
}

/** 벡터 검색 한 번. 질의가 여러 개면 이걸 질의마다 돈다. */
async function vectorSearch(qv: readonly number[], limit: number): Promise<RetrievedChunk[]> {
  const res = await db().query<ChunkRow>(
    `SELECT ${CHUNK_COLUMNS}, c.embedding <=> $1::vector AS distance
       FROM chunks c
       JOIN documents d ON d.id = c.doc_id
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2`,
    [toVectorLiteral(qv), limit],
  );
  return res.rows.map(toChunk);
}

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveResponse> {
  const topK = opts.topK ?? config.retrieveTopK;
  const topN = opts.topN ?? config.rerankTopN;
  const rerankEnabled = opts.rerankEnabled ?? config.rerankEnabled;
  const hybridEnabled = opts.hybridEnabled ?? config.hybridEnabled;
  const rewriteEnabled = opts.rewriteEnabled ?? config.rewriteEnabled;

  /*
   * 1단계 — 질의 확장.
   *
   * 재작성을 끄면 목록은 원문 하나다. 아래 코드는 그 경우를 특수 케이스로 두지 않는다:
   * "질의 1개짜리 다중 질의"로 흐르면 두 경로가 갈라지지 않아 버그가 한쪽에만 생기는 일이 없다.
   */
  const tStart = performance.now();
  const rw = rewriteEnabled
    ? await rewriteQuery(query)
    : { queries: [query], ms: 0, inputTokens: 0, outputTokens: 0, failed: false, fromCache: false };
  const queries = rw.queries;
  const tRewrite = performance.now();

  const qvs = await embedQueries(queries);
  const tEmbed = performance.now();

  // 2단계 — 질의마다 벡터 검색. 원문이 항상 [0] 이다 (rewrite.ts).
  const perQueryHits = await Promise.all(qvs.map((qv) => vectorSearch(qv, topK)));
  const tVector = performance.now();

  const byId = new Map<number, RetrievedChunk>();
  for (const hits of perQueryHits) for (const c of hits) if (!byId.has(c.id)) byId.set(c.id, c);

  const vectorRankings = perQueryHits.map((hits) => hits.map((c) => c.id));
  const vectorOrder = vectorRankings[0] ?? [];

  /*
   * 3단계 — 키워드 검색 (하이브리드).
   *
   * 벡터 검색은 의미가 비슷하면 어휘가 달라도 잡지만 정확한 식별자에는 약하고,
   * 키워드 검색은 정반대다. **실패 모드가 다른 두 검색을 합치는 것**이 요점이지
   * 둘 다 쓰면 좋다는 게 아니다. 어느 쪽도 못 찾는 청크는 여전히 못 찾는다.
   *
   * 재작성과 같이 켜면 키워드 검색도 재작성문으로 돈다 — 그래야 하이브리드가
   * 어휘 격차 때문에 졌던 D13 의 조건이 실제로 바뀐다.
   */
  const keywordRankings: number[][] = [];
  if (hybridEnabled) {
    const perQueryKeyword = await Promise.all(queries.map((q) => keywordSearch(q, topK)));
    for (const hits of perQueryKeyword) {
      for (const c of hits) if (!byId.has(c.id)) byId.set(c.id, c);
      keywordRankings.push(hits.map((c) => c.id));
    }
  }
  const tKeyword = performance.now();

  /*
   * 4단계 — 융합.
   *
   * 순위 목록이 하나뿐이면 RRF 는 항등이다(1/(k+i) 가 단조감소이므로 순서가 보존된다).
   * 그래서 재작성·하이브리드를 모두 끈 경로도 같은 코드를 지난다.
   *
   * 융합 후 후보를 topK 로 자른다 — 리랭커 비용이 후보 수에 비례하기 때문이다.
   * 질의 4개면 후보 풀은 최대 80개까지 커지는데, 그걸 다 리랭킹하면 지연시간이 4배가 된다.
   */
  const candidates = fuseByRank([...vectorRankings, ...keywordRankings])
    .slice(0, topK)
    .map((id) => byId.get(id))
    .filter((c): c is RetrievedChunk => c !== undefined);

  const baseTrace = {
    query,
    topK,
    topN,
    rerankEnabled,
    hybridEnabled,
    rewriteEnabled,
    queries,
    rewriteFailed: rw.failed,
    rewriteFromCache: rw.fromCache,
    vectorOrder,
    keywordOrder: keywordRankings[0] ?? [],
    rewriteTokens: { input: rw.inputTokens, output: rw.outputTokens },
  };

  if (!rerankEnabled) {
    const chunks = candidates.slice(0, topN);
    return {
      chunks,
      trace: {
        ...baseTrace,
        finalOrder: chunks.map((c) => c.id),
        // rewrite 는 벽시계가 아니라 `rw.ms` 를 쓴다 — 캐시 적중이면 정확히 0 이어야
        // "실제로 호출한 횟수"를 이 값으로 셀 수 있다 (벽시계는 0.05ms 로 0 이 아니다).
        ms: {
          rewrite: rw.ms,
          embed: tEmbed - tRewrite,
          vector: tVector - tEmbed,
          keyword: tKeyword - tVector,
          rerank: 0,
        },
      },
    };
  }

  // 리랭커에는 헤딩을 붙여 넣는다 — 임베딩 때와 같은 이유다(chunk.ts 의 embedText 주석 참조).
  const docsForRerank = candidates.map((c) => (c.headingPath ? `${c.headingPath}\n\n${c.content}` : c.content));
  /*
   * 리랭커에 무엇을 질의로 줄 것인가 — `config.rerankQuery`.
   *
   * 기본은 **원문**이다. 재작성문은 "어디를 볼지"를 넓히는 도구고, "무엇이 답인지"의 기준은
   * 사용자가 실제로 물은 문장이어야 한다. 재작성이 `work_mem` 으로 좁혀놨는데 그 낱말로만
   * 리랭킹하면, 재작성의 추측을 리랭커가 한 번 더 확증해 주는 꼴이라 틀렸을 때 되돌릴 길이 없다.
   *
   * 다만 그 기본값에는 대가가 있다. **리랭커는 어휘 격차를 넘지 못한다** — 크로스 인코더는
   * 작은 모델이라 "routine table cleanup" 과 `maintenance_work_mem` 을 잇는 도메인 지식이
   * 없다. 재작성이 정답을 후보에 넣어줘도 원문으로 다시 점수를 매기면 도로 밀려난다.
   * `expanded` 는 원문과 재작성문을 함께 줘서 그 격차를 리랭킹 단계에서도 메우려는 시도다.
   *
   * 어느 쪽이 나은지는 추측하지 않고 두 값으로 돌려서 정한다.
   */
  const rerankQueryText =
    config.rerankQuery === "expanded" && queries.length > 1 ? queries.join("\n") : query;
  const ranked = await rerank(rerankQueryText, docsForRerank, topN);
  const tRerank = performance.now();

  const chunks: RetrievedChunk[] = [];
  for (const r of ranked) {
    const base = candidates[r.index];
    // 리랭커가 범위 밖 인덱스를 주는 일은 없어야 하지만, 그런 응답이 오면 조용히 버리는 대신 건너뛴다.
    if (base) chunks.push({ ...base, rerankScore: r.relevanceScore });
  }

  return {
    chunks,
    trace: {
      ...baseTrace,
      finalOrder: chunks.map((c) => c.id),
      ms: {
        rewrite: rw.ms,
        embed: tEmbed - tRewrite,
        vector: tVector - tEmbed,
        keyword: tKeyword - tVector,
        rerank: tRerank - tKeyword,
      },
    },
  };
}
