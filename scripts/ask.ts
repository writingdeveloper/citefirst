/**
 * CLI 질의 — UI 없이 3·4단계를 확인하는 용도.
 *
 *   npm run ask -- "work_mem 기본값은?"
 *   npm run ask -- "..." --no-rerank      리랭킹 끄고 비교
 *   npm run ask -- "..." --retrieve-only  검색 결과만 (답변 모델 호출 안 함)
 *   npm run ask -- "..." --rewrite        쿼리 재작성 켜고 (--no-rewrite 로 강제 끄기)
 */
import { loadEnv } from "./_env.ts";
import { closeDb } from "../src/lib/db/client.ts";
import { retrieve } from "../src/lib/retrieve/index.ts";
import { answerQuestion } from "../src/lib/answer/index.ts";
import { formatError } from "../src/lib/errors.ts";

loadEnv();

async function main() {
  const question = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!question) throw new Error(`질문을 주세요.  예: npm run ask -- "work_mem 기본값은?"`);

  const rerankEnabled = !process.argv.includes("--no-rerank");
  const retrieveOnly = process.argv.includes("--retrieve-only");
  // 플래그가 없으면 undefined 를 넘겨 config 기본값을 따르게 한다 (false 를 넘기면 강제 OFF 가 된다).
  const rewriteEnabled = process.argv.includes("--rewrite")
    ? true
    : process.argv.includes("--no-rewrite")
      ? false
      : undefined;

  if (retrieveOnly) {
    const { chunks, trace } = await retrieve(question, { rerankEnabled, rewriteEnabled });
    if (trace.rewriteEnabled) {
      console.log(`재작성된 질의 (원문 포함 ${trace.queries.length}개)${trace.rewriteFailed ? " ⚠ 재작성 실패 — 원문만 사용" : ""}`);
      for (const [i, q] of trace.queries.entries()) console.log(`  ${i === 0 ? "원문" : `재작성${i}`}: ${q}`);
      console.log();
    }
    console.log(`검색 ${chunks.length}건 (리랭킹 ${rerankEnabled ? "on" : "off"})\n`);
    for (const c of chunks) {
      console.log(`[c${c.id}] ${c.headingPath ?? c.docTitle}`);
      console.log(`  거리 ${c.distance.toFixed(4)}${c.rerankScore !== undefined ? ` · 리랭크 ${c.rerankScore.toFixed(4)}` : ""}`);
      console.log(`  ${c.content.slice(0, 160).replace(/\n/g, " ")}…\n`);
    }
    const { rewrite, embed, vector, keyword, rerank } = trace.ms;
    console.log(
      `시간: rewrite ${rewrite.toFixed(0)}ms · embed ${embed.toFixed(0)}ms · vector ${vector.toFixed(0)}ms · ` +
        `keyword ${keyword.toFixed(0)}ms · rerank ${rerank.toFixed(0)}ms · 합계 ${(rewrite + embed + vector + keyword + rerank).toFixed(0)}ms`,
    );
    return;
  }

  const res = await answerQuestion(question, { rerankEnabled, rewriteEnabled });

  console.log(`\n${res.answer.text}\n`);
  console.log(`— 인용 ${res.answer.cited.length}건`);
  for (const c of res.answer.cited) {
    console.log(`  [c${c.id}] ${c.headingPath ?? c.docTitle}  (${c.sourcePath})`);
  }
  if (res.answer.hallucinated.length > 0) {
    console.log(`  ⚠ 검증 실패한 인용 ${res.answer.hallucinated.length}건: ${res.answer.hallucinated.join(", ")}`);
  }
  console.log(
    `\n${res.ms.toFixed(0)}ms · 입력 ${res.usage.inputTokens} (캐시 읽음 ${res.usage.cacheReadTokens}) · 출력 ${res.usage.outputTokens}`,
  );
}

main()
  .catch((err) => {
    console.error(formatError(err));
    process.exitCode = 1;
  })
  .finally(closeDb);
