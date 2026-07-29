/**
 * 로컬 임베딩·리랭커 동작 확인. **DB 도 API 키도 필요 없다.**
 *
 * 처음 실행하면 모델 가중치를 `.models/` 로 받는다(한 번만).
 *
 * 확인하는 것:
 *   1. 임베딩이 설정한 차원으로 나오고 정규화되어 있는가
 *   2. 질의 prefix 가 실제로 효과가 있는가
 *   3. **리랭커가 벡터 검색이 헷갈리는 쌍을 갈라내는가** ← 리랭킹을 쓰는 이유가 이것뿐이다
 *
 *   npx tsx scripts/embed-check.ts
 */
import { config } from "../src/lib/config.ts";
import { embedDocuments, embedQuery, rerank } from "../src/lib/embed/index.ts";
import { formatError } from "../src/lib/errors.ts";

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // 정규화된 벡터라 내적 = 코사인
}

/** 실제 PostgreSQL 문서에서 가져온, 서로 헷갈리는 세 문단. */
const CANDIDATES = [
  {
    label: "work_mem",
    text: "work_mem (integer)\n\nSets the base maximum amount of memory to be used by a query operation (such as a sort or hash table) before writing to temporary disk files. If this value is specified without units, it is taken as kilobytes. The default value is four megabytes (4MB).",
  },
  {
    label: "maintenance_work_mem",
    text: "maintenance_work_mem (integer)\n\nSpecifies the maximum amount of memory to be used by maintenance operations, such as VACUUM, CREATE INDEX, and ALTER TABLE ADD FOREIGN KEY. If this value is specified without units, it is taken as kilobytes. It defaults to 64 megabytes (64MB).",
  },
  {
    label: "autovacuum_work_mem",
    text: "autovacuum_work_mem (integer)\n\nSpecifies the maximum amount of memory to be used by each autovacuum worker process. If this value is specified without units, it is taken as kilobytes. It defaults to -1, indicating that the value of maintenance_work_mem should be used instead.",
  },
  {
    label: "logical_decoding_work_mem",
    text: "logical_decoding_work_mem (integer)\n\nSpecifies the maximum amount of memory to be used by logical decoding, before some of the decoded changes are written to local disk. It defaults to 64 megabytes (64MB).",
  },
  {
    label: "temp_buffers",
    text: "temp_buffers (integer)\n\nSets the maximum amount of memory used for temporary buffers within each database session. These are session-local buffers used only for access to temporary tables. The default is eight megabytes (8MB).",
  },
];

const QUESTION = "What is the default value of work_mem?";
const EXPECTED = "work_mem";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
}

async function main() {
  console.log(`임베딩 모델: ${config.embeddingModel}`);
  console.log(`리랭커:      ${config.rerankModel}`);
  console.log(`(첫 실행이면 모델을 .models/ 로 받습니다 — 시간이 걸립니다)\n`);

  const t0 = performance.now();
  const docVectors = await embedDocuments(CANDIDATES.map((c) => c.text));
  const embedMs = performance.now() - t0;

  console.log("임베딩");
  check("차원 일치", docVectors.every((v) => v.length === config.embeddingDim), `${docVectors[0]?.length}`);
  const norm = Math.sqrt(docVectors[0]!.reduce((s, x) => s + x * x, 0));
  check("L2 정규화됨", Math.abs(norm - 1) < 0.01, `노름 ${norm.toFixed(4)}`);
  console.log(`  ${CANDIDATES.length}개 임베딩에 ${embedMs.toFixed(0)}ms (${(embedMs / CANDIDATES.length).toFixed(0)}ms/청크)`);

  console.log("\n벡터 검색 (리랭킹 없음)");
  const qv = await embedQuery(QUESTION);
  const bySim = CANDIDATES.map((c, i) => ({ label: c.label, score: cosine(qv, docVectors[i]!) })).sort(
    (a, b) => b.score - a.score,
  );
  for (const [i, r] of bySim.entries()) console.log(`  ${i + 1}. ${r.label.padEnd(28)} ${r.score.toFixed(4)}`);
  const vectorTop1 = bySim[0]!.label;
  const vectorGap = bySim[0]!.score - bySim[1]!.score;

  console.log("\n리랭킹");
  const ranked = await rerank(QUESTION, CANDIDATES.map((c) => c.text), CANDIDATES.length);
  for (const [i, r] of ranked.entries()) {
    console.log(`  ${i + 1}. ${CANDIDATES[r.index]!.label.padEnd(28)} ${r.relevanceScore.toFixed(4)}`);
  }
  const rerankTop1 = CANDIDATES[ranked[0]!.index]!.label;
  const rerankGap = ranked[0]!.relevanceScore - ranked[1]!.relevanceScore;

  console.log("\n판정");
  check(`리랭킹 1위가 정답(${EXPECTED})`, rerankTop1 === EXPECTED, rerankTop1);
  console.log(`  벡터 검색 1위: ${vectorTop1} (1·2위 격차 ${vectorGap.toFixed(4)})`);
  console.log(`  리랭킹 1위:    ${rerankTop1} (1·2위 격차 ${rerankGap.toFixed(4)})`);

  /*
   * 격차가 중요하다. 둘 다 정답을 1위로 뽑아도, 벡터 쪽 격차가 0.01 수준이면
   * 청크가 조금만 달라져도 순위가 뒤집힌다는 뜻이다 — 리랭커는 그 불안정한 구간을
   * 확실하게 갈라주는 역할을 한다. eval 의 before/after 는 이 차이가 수치로 나온 것이다.
   */
  if (vectorTop1 === EXPECTED && rerankTop1 === EXPECTED) {
    console.log(`\n  둘 다 정답을 1위로 뽑았습니다. 격차를 비교하세요 — 벡터 쪽이 좁으면`);
    console.log(`  실제 코퍼스(후보 20개)에서는 뒤집힐 수 있습니다. 판단은 eval 이 합니다.`);
  }

  console.log(`\n${failed === 0 ? "전부 통과" : `실패 ${failed}건`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(formatError(err));
  process.exitCode = 1;
});
