import { existsSync, readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";

/**
 * 쿼리 재작성 — 어휘 격차(vocabulary gap)를 좁히는 시도.
 *
 * ## 왜 필요한가
 *
 * 사용자는 증상으로 묻는다: *"My sorts keep spilling to disk. Which setting caps that memory?"*
 * 정답 문단에는 그 문장의 낱말이 거의 없다. 거기 있는 건 `work_mem` 이다.
 *
 * 하이브리드 검색(FTS+벡터)으로 이걸 고치려 했지만 **실패했다** (D13): 질문에 식별자가
 * 없으면 키워드 검색도 그 문서를 못 찾는다. 두 검색기 모두 사용자가 쓴 낱말에 묶여 있다.
 * 격차를 넘으려면 **질문의 어휘 자체를 바꿔야** 한다. 그게 이 모듈이다.
 *
 * ## 정직하게 말해야 할 것
 *
 * 재작성 모델은 PostgreSQL 을 이미 알고 있다. "sorts spilling to disk" → `work_mem` 은
 * 검색이 아니라 **모델의 사전지식**이다. 따라서 이 기법으로 오른 recall 은
 * "검색기가 좋아졌다"가 아니라 **"질의 앞단에 도메인 지식을 하나 더 붙였다"** 로 읽어야 한다.
 *
 * 실용적으로는 여전히 유효하다 — 운영 환경에서도 같은 모델을 쓸 수 있으니까. 다만
 * 클라이언트 코퍼스가 모델이 모르는 사내 문서라면 **이 효과는 재현되지 않는다.**
 * 포트폴리오에 수치를 쓸 때 이 한 줄을 빼면 그 수치는 오해를 만든다.
 *
 * ## 설계
 *
 * - **원문 질의를 항상 후보에 남긴다.** 재작성이 엉뚱하게 나가도 검색이 무너지지 않는다.
 * - **리랭커에도 재작성문을 준다** (`RERANK_QUERY=expanded`, retrieve/index.ts).
 *   원래는 "리랭킹의 기준은 사용자가 실제로 물은 문장이어야 한다"고 보고 원문만 줬는데,
 *   **측정이 그 직관을 뒤집었다**: 리랭커도 어휘 격차를 못 넘어서, 재작성이 찾아낸 청크를
 *   "질문과 안 닮았다"며 도로 밀어냈다 (recall@5 0.957 → 0.848). 자세한 건 D15.
 * - **캐시한다.** eval 은 같은 질문을 리랭킹 OFF/ON 두 번 돌린다. 재작성이 두 번 다르게
 *   나오면 before/after 차이에 재작성 변동이 섞여 비교가 성립하지 않는다.
 *
 * ## 캐시를 디스크에 두는 이유 — 실측으로 드러난 문제
 *
 * 프로세스 안 캐시만으로는 **실행 간** 변동을 못 막는다. 같은 설정(REWRITE_ENABLED=true,
 * 리랭킹 OFF)으로 두 번 돌렸더니 recall@5 가 0.962 와 1.000 으로 갈렸다. 설정은 하나도
 * 안 바뀌었고, 달라진 건 그날 모델이 뽑은 재작성문뿐이었다.
 *
 * 그 상태로 "expanded 가 original 보다 낫다"를 주장하면 **차이의 일부가 잡음이다.**
 * 그래서 재작성 결과를 파일에 얼려 커밋한다. 같은 질의로 다시 돌리면 같은 숫자가 나오고,
 * 그때 남는 차이는 정말로 바뀐 변수 때문이다.
 *
 * 캐시 파일에는 최초 호출의 **지연시간과 토큰도 같이** 적는다. 비용을 못 재게 되면
 * 이득만 있고 대가는 없는 표가 되기 때문이다.
 */

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  client ??= new Anthropic({
    apiKey: config.anthropicApiKey(),
    baseURL: config.anthropicBaseUrl(),
    maxRetries: 5,
  });
  return client;
}

const REWRITE_SYSTEM = `You rewrite a user's question into search queries for a vector search over the PostgreSQL 17 documentation.

You are NOT answering the question. You are guessing what words the documentation itself would use.

Users describe symptoms; the manual describes mechanisms. Bridge that gap:
- "sorts keep spilling to disk" -> the manual says "work_mem", "sort operations", "temporary files"
- "reclaim space back to the OS" -> the manual says "VACUUM FULL", "rewrite the table"
- "back up every database at once" -> the manual says "pg_dumpall", "cluster-wide"

Rules:
- Produce 2 to 3 queries. Each must be a short noun phrase or sentence, not a question.
- Include exact identifiers (parameter names, command names, function names) when you are confident of them. That is the entire point.
- If you are NOT confident of an identifier, do not invent one. A plausible-looking wrong parameter name is worse than no identifier: it pulls retrieval toward the wrong page. Write a descriptive phrase instead.
- Make the queries differ from each other. Three phrasings of the same guess add nothing.
- Never state the answer value (a default, a number, a version). You are producing search text, not facts.

Reply with a single JSON array of strings and nothing else — no prose, no code fence:

["...", "..."]

The response is parsed by a program. Anything other than that array is a failed run.`;

export interface RewriteResult {
  /** 원문을 **맨 앞에** 두고 재작성문을 이은 목록. 항상 길이 >= 1. */
  readonly queries: readonly string[];
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 모델 호출이나 파싱이 실패해 원문만 남았는지. eval 이 이 개수를 보고한다. */
  readonly failed: boolean;
  readonly failReason?: string;
  /** 디스크 캐시에서 읽었는지. `ms`·토큰은 이 경우 **최초 호출 때 기록된 실측값**이다. */
  readonly fromCache: boolean;
}

/**
 * 응답에서 질의 배열을 뽑는다.
 *
 * judge 의 `parseVerdict` 와 같은 이유로 구조화 출력을 믿지 않는다 — 프록시가 조용히
 * 무시한다 (AGENTS.md §2). 다만 여기서는 **던지지 않고** 실패를 값으로 돌려준다:
 * 재작성은 있으면 좋은 것이고, 실패했다고 검색 전체를 멈출 이유가 없다.
 * 대신 `failed` 를 세어 보고한다 — 조용히 넘어가지는 않는다.
 */
export function parseQueries(text: string): string[] {
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`JSON 배열을 찾지 못했습니다: ${text.slice(0, 200)}`);

  const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("최상위가 배열이 아닙니다.");

  const queries = parsed
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

  if (queries.length === 0) throw new Error("빈 배열입니다.");
  return queries;
}

interface CacheEntry {
  readonly model: string;
  readonly queries: readonly string[];
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** 캐시 키에 모델을 넣는다 — 모델을 바꾸면 예전 재작성을 그대로 쓰면 안 된다. */
function cacheKey(question: string): string {
  return `${config.rewriteModel}::${question}`;
}

const cache = new Map<string, CacheEntry>();
let loaded = false;

function loadCache(): void {
  if (loaded) return;
  loaded = true;
  if (config.rewriteCachePath === "" || !existsSync(config.rewriteCachePath)) return;
  try {
    const raw = JSON.parse(readFileSync(config.rewriteCachePath, "utf8")) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(raw)) {
      // 키에 모델이 붙어 있으므로 다른 모델의 항목은 자연히 안 맞는다. 형식만 확인한다.
      if (Array.isArray(v?.queries) && v.queries.length > 0) cache.set(k, v);
    }
  } catch (err) {
    // 캐시가 깨졌다고 검색을 멈출 이유는 없지만, 조용히 넘어가면 "왜 매번 느리지"가 된다.
    console.warn(`재작성 캐시를 읽지 못했습니다 (${config.rewriteCachePath}): ${err instanceof Error ? err.message : err}`);
  }
}

function persist(): void {
  if (config.rewriteCachePath === "") return;
  // 키를 정렬해 쓴다 — 안 하면 삽입 순서가 바뀔 때마다 diff 가 통째로 뒤집힌다.
  const obj: Record<string, CacheEntry> = {};
  for (const k of [...cache.keys()].sort()) obj[k] = cache.get(k)!;
  writeFileSync(config.rewriteCachePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

export async function rewriteQuery(question: string): Promise<RewriteResult> {
  loadCache();
  const key = cacheKey(question);

  const hit = cache.get(key);
  if (hit) {
    return {
      queries: hit.queries,
      ms: hit.ms,
      inputTokens: hit.inputTokens,
      outputTokens: hit.outputTokens,
      failed: false,
      fromCache: true,
    };
  }

  const t0 = performance.now();
  let result: RewriteResult;

  try {
    const msg = await anthropic().messages.create({
      model: config.rewriteModel,
      max_tokens: 2000,
      system: [{ type: "text", text: REWRITE_SYSTEM, cache_control: { type: "ephemeral" } }],
      // 재작성은 판단이 얕은 작업이다. effort 를 올려도 얻을 게 없고 지연시간만 는다.
      output_config: { effort: "low" },
      messages: [{ role: "user", content: question }],
    });

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const rewritten = parseQueries(text).slice(0, config.rewriteMaxQueries);

    /*
     * 원문이 항상 첫 번째다. RRF 는 순위만 쓰므로 순서 자체에 가중치는 없지만,
     * 동점일 때 원문 쪽 후보가 먼저 오게 된다 — 재작성이 빗나갔을 때의 안전판이다.
     */
    result = {
      queries: [question, ...rewritten],
      ms: performance.now() - t0,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      failed: false,
      fromCache: false,
    };
  } catch (err) {
    result = {
      queries: [question],
      ms: performance.now() - t0,
      inputTokens: 0,
      outputTokens: 0,
      failed: true,
      failReason: err instanceof Error ? err.message : String(err),
      fromCache: false,
    };
  }

  /*
   * **실패는 캐시하지 않는다.** 프록시가 잠깐 죽어서 실패한 걸 파일에 얼려두면
   * 그 질문은 영원히 원문만 쓰게 되고, 원인은 커밋된 캐시 파일 안에 숨는다.
   */
  if (!result.failed) {
    cache.set(cacheKey(question), {
      model: config.rewriteModel,
      queries: result.queries,
      ms: result.ms,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    persist();
  }
  return result;
}
