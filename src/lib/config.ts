import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 설정은 전부 여기로 모은다.
 *
 * 이유: eval 결과를 포트폴리오에 쓰려면 "어떤 설정으로 낸 숫자인지"를 같이 기록해야 한다.
 * 값이 코드 곳곳에 흩어져 있으면 그 기록이 불가능하다. `snapshotConfig()`가 그 스냅샷이다.
 */

/*
 * .env 를 **여기서** 읽는다.
 *
 * 아래 설정값들은 모듈 로드 시점에 즉시 평가된다. 스크립트가 loadEnv() 를 호출하더라도
 * import 가 먼저 실행되므로 그때는 이미 늦다 — 실제로 ANSWER_MODEL 을 .env 에 넣었는데
 * 기본값 claude-opus-5 가 그대로 나가서 502 를 받았다. 기본값이 우연히 맞는 동안은
 * 드러나지 않는 종류의 버그다.
 *
 * 이미 설정된 환경변수는 덮어쓰지 않으므로, 실제 환경변수가 항상 .env 를 이긴다.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_PATH = path.join(ROOT, ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`환경변수 ${name} 가 없습니다. .env.example 을 참고해 .env 를 채우세요.`);
  }
  return v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`환경변수 ${name} 가 정수가 아닙니다: ${raw}`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

/**
 * 정해진 값 중 하나여야 하는 설정.
 *
 * 오타를 조용히 기본값으로 넘기지 않는다 — `RERANK_QUERY=expandded` 로 돌린 실험 결과가
 * 사실은 기본 설정 결과였다면, 그 표는 틀린 채로 포트폴리오에 들어간다.
 */
function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`환경변수 ${name} 값이 잘못됐습니다: "${raw}". 가능한 값: ${allowed.join(" | ")}`);
  }
  return raw as T;
}

export const config = {
  databaseUrl: () => env("DATABASE_URL", "postgresql://citefirst:citefirst@localhost:5432/citefirst"),
  /** CLIProxyAPI 를 쓰면 프록시가 인증을 들고 있으므로 키는 자리표시자면 된다. */
  anthropicApiKey: () => env("ANTHROPIC_API_KEY", "proxy"),
  /**
   * Anthropic 호환 엔드포인트. 비우면 api.anthropic.com 으로 직접 간다.
   * CLIProxyAPI 를 쓸 때 여기에 프록시 주소를 넣는다 (예: http://localhost:8317).
   */
  anthropicBaseUrl: () => process.env["ANTHROPIC_BASE_URL"] || undefined,

  /**
   * 임베딩·리랭킹은 **로컬에서 돈다** (docs/decisions.md D11).
   * 문서가 외부로 나가지 않는 게 이 스택의 핵심 성질이다.
   */
  embeddingModel: env("EMBEDDING_MODEL", "Xenova/bge-base-en-v1.5"),
  /** bge-base-en-v1.5 의 출력 차원. 001_init.sql 의 vector(...) 와 반드시 일치해야 한다. */
  embeddingDim: envInt("EMBEDDING_DIM", 768),
  rerankModel: env("RERANK_MODEL", "Xenova/bge-reranker-base"),
  /**
   * BGE 계열은 질의에 지시문 prefix 를 붙여야 비대칭 검색(짧은 질문 → 긴 문단) 성능이 나온다.
   * 문서 쪽에는 붙이지 않는다. Voyage 의 inputType 과 같은 역할이다.
   */
  queryPrefix: env(
    "QUERY_PREFIX",
    "Represent this sentence for searching relevant passages: ",
  ),

  chunkTokens: envInt("CHUNK_TOKENS", 512),
  chunkOverlap: envInt("CHUNK_OVERLAP", 64),

  retrieveTopK: envInt("RETRIEVE_TOP_K", 20),
  rerankTopN: envInt("RERANK_TOP_N", 5),
  /** eval 에서 on/off 두 번 돌려 before/after 표를 만든다 (D3). */
  rerankEnabled: envBool("RERANK_ENABLED", true),
  /**
   * 키워드 검색(Postgres FTS)을 벡터 검색과 RRF 로 합칠지.
   *
   * **기본값이 false 인 이유는 측정 결과다** — 단, 어느 측정인지가 중요하다.
   *
   * **질문 26개 · 재작성 도입 전**: 하이브리드는 함정 질문 recall@5 를 0.895 → 0.842 로
   * **떨어뜨렸다.** 질문에 "VACUUM" 같은 식별자가 없으면 키워드 검색도 그 문서를 못 찾고,
   * 대신 엉뚱한 문서를 상위로 올려 RRF 에서 좋은 벡터 후보를 밀어낸다.
   * 식별자를 쓰는 질문에서는 반대로 MRR@10 을 0.804 → 0.821 로 올렸다.
   *
   * **질문 46개 · 재작성 ON**: 그 원인이 사라진다 — 재작성문에는 식별자가 들어 있다.
   * recall@5 는 0.978 로 같고 MRR@10 이 0.853 → 0.865 로 오른다. 즉 **지금은 해롭지 않다.**
   * 그래도 기본값을 끈 채 두는 이유는 "해롭다"가 아니라 **작은 MRR 이득이 인덱스 하나와
   * 질의당 검색 한 번을 더 지불할 값은 아니라서**다. (식별자 세트는 46문항에서 재측정 안 함.)
   *
   * "하이브리드 검색은 항상 낫다"는 통념이 여기서는 틀렸다. 측정 없이 켰으면
   * 성능을 떨어뜨리고도 몰랐을 것이다.
   */
  hybridEnabled: envBool("HYBRID_ENABLED", false),

  /**
   * 질의를 LLM 으로 재작성해 여러 개로 검색할지 (src/lib/retrieve/rewrite.ts).
   *
   * 하이브리드가 못 넘은 어휘 격차를 넘는 유일한 수단이다 — 사용자의 낱말이 아니라
   * **문서의 낱말**로 검색하게 만든다. 대가는 질의당 LLM 호출 1회(지연시간·비용)다.
   *
   * **측정은 끝났다** (D15, 46문항): 증상 질문 recall@5 0.783 → 0.978, MRR@10 0.527 → 0.853.
   * **출시 구성은 ON 이고, 그건 `.env.example` 이 `REWRITE_ENABLED=true` 로 켠다.**
   *
   * 그런데도 **여기 코드 기본값을 false 로 두는 이유**는 따로 있다: 이 값이 true 면
   * 답변 엔드포인트를 설정하지 않은 상태에서도 질의마다 LLM 호출을 시도한다. 실패해도
   * 원문만으로 검색이 계속되지만(`rewriteFailed`), 질문마다 타임아웃을 기다리게 된다.
   * **레포를 막 클론한 사람이 임베딩·검색만으로 돌려볼 수 있어야** 하므로 기본은 끈다.
   * 즉 이 기본값은 "아직 안 정했다"가 아니라 **"엔드포인트 없이도 도는 구성"**이라는 뜻이다.
   */
  rewriteEnabled: envBool("REWRITE_ENABLED", false),
  /** 재작성 모델. 기본은 답변 모델과 같게 두되, 싼 모델로 내려볼 수 있게 분리한다. */
  rewriteModel: env("REWRITE_MODEL", env("ANSWER_MODEL", "gpt-5.6-sol")),
  /** 재작성문 개수 상한(원문 제외). 늘릴수록 검색 횟수와 임베딩 비용이 선형으로 는다. */
  rewriteMaxQueries: envInt("REWRITE_MAX_QUERIES", 3),
  /**
   * 리랭커에 **어떤 질의**를 줄지. 재작성을 켰을 때만 의미가 있다.
   *
   * - `original` — 사용자가 실제로 물은 문장. 재작성이 빗나가도 리랭커가 되돌릴 수 있다.
   * - `expanded` — 원문 + 재작성문을 이어붙인 것.
   *
   * 이건 취향이 아니라 **측정 대상**이었고, 측정은 끝났다 (D15, 46문항):
   * `original` 로 채점하면 recall@5 가 **0.978 → 0.848** 로 떨어진다. 재작성이 어휘 격차를
   * 넘어 정답을 후보에 넣어도, 리랭커가 원문으로 다시 점수를 매기면 그 정답을 도로 밀어낸다.
   *
   * **출시 구성은 `expanded` 이고 `.env.example` 이 그렇게 설정한다.** 여기 기본값이
   * `original` 인 이유는 이 값이 `rewriteEnabled` 가 켜져 있을 때만 의미를 갖기 때문이다 —
   * 위의 기본값(재작성 OFF)과 짝이 맞는 값이다. **재작성을 켰다면 반드시 `expanded` 로 둔다.**
   */
  rerankQuery: envEnum("RERANK_QUERY", ["original", "expanded"] as const, "original"),
  /**
   * 재작성 결과를 얼려두는 파일. 빈 문자열이면 디스크 캐시를 쓰지 않는다.
   *
   * 이걸 커밋해야 eval 숫자가 재현된다 (rewrite.ts 상단 참조). 재작성을 새로 뽑고 싶으면
   * 파일을 지우고 돌린다 — 그러면 숫자도 같이 바뀔 수 있다는 뜻이니 그때는 표를 다시 낸다.
   */
  rewriteCachePath: env("REWRITE_CACHE_PATH", path.join(ROOT, "eval", "rewrite-cache.json")),

  /**
   * 답변·judge 모델.
   *
   * 답변 계층은 **Anthropic Messages 프로토콜**을 말한다. 그 프로토콜을 받아주는 엔드포인트면
   * 어디든 붙는다 — 모델 이름만 바꾸면 되고 SDK 호출부는 그대로다 (docs/decisions.md D12).
   * 기본값은 실제로 측정에 쓴 모델이다.
   */
  answerModel: env("ANSWER_MODEL", "gpt-5.6-sol"),
  answerEffort: env("ANSWER_EFFORT", "low"),
  judgeModel: env("JUDGE_MODEL", "gpt-5.6-sol"),
} as const;

/** eval 결과 파일에 같이 저장할 설정 스냅샷. 비밀값은 넣지 않는다. */
export function snapshotConfig() {
  return {
    embeddingModel: config.embeddingModel,
    embeddingDim: config.embeddingDim,
    rerankModel: config.rerankModel,
    chunkTokens: config.chunkTokens,
    chunkOverlap: config.chunkOverlap,
    retrieveTopK: config.retrieveTopK,
    rerankTopN: config.rerankTopN,
    hybridEnabled: config.hybridEnabled,
    rewriteEnabled: config.rewriteEnabled,
    rewriteModel: config.rewriteEnabled ? config.rewriteModel : null,
    rewriteMaxQueries: config.rewriteEnabled ? config.rewriteMaxQueries : null,
    rerankQuery: config.rewriteEnabled ? config.rerankQuery : null,
    answerModel: config.answerModel,
    answerEffort: config.answerEffort,
    judgeModel: config.judgeModel,
  };
}
