/**
 * 평가 하네스 — 이 레포의 최종 산출물.
 *
 *   npm run eval                    리랭킹 on/off 둘 다 돌려 비교표 생성
 *   npm run eval -- --retrieval-only  답변/judge 호출 없이 검색 지표만 (빠르고 싸다)
 *   npm run eval -- --only q001,q004  특정 질문만
 *
 * 결과는 eval/results/ 에 저장하고 커밋한다. 포트폴리오에 쓰는 숫자의 출처가 이 파일들이다.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { loadEnv } from "../scripts/_env.ts";
import { closeDb } from "../src/lib/db/client.ts";
import { config, snapshotConfig } from "../src/lib/config.ts";
import { answerQuestion } from "../src/lib/answer/index.ts";
import { retrieve, type RetrieveTrace } from "../src/lib/retrieve/index.ts";
import { mrrAtK, recallAtK, resolveGold } from "./gold.ts";
import { judge, type Verdict } from "./judge.ts";
import { validateQuestion, type EvalQuestion } from "./schema.ts";
import { formatError } from "../src/lib/errors.ts";

loadEnv();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, "results");

/** 검색은 topK=20 에서 하고, MRR@10 을 계산하려면 리랭킹도 10개는 돌려받아야 한다. */
const EVAL_TOP_N = 10;
const RECALL_K = 5;
const MRR_K = 10;

interface QuestionResult {
  readonly id: string;
  readonly question: string;
  readonly trap?: string;
  readonly goldChunkIds: readonly number[];
  readonly retrievedIds: readonly number[];
  readonly recallAt5: number;
  readonly mrrAt10: number;
  readonly citationsTotal?: number;
  readonly citationsHallucinated?: number;
  readonly verdict?: Verdict;
  readonly answer?: string;
  /**
   * 재작성이 실제로 무엇을 만들었는지. 재작성을 끄면 원문 하나뿐이라 기록하지 않는다.
   * 수치만 남기고 이걸 안 남기면 "왜 올랐는지"를 나중에 설명할 수 없다.
   */
  readonly queries?: readonly string[];
  readonly rewriteFailed?: boolean;
  readonly rewriteFromCache?: boolean;
  readonly retrieveMs?: number;
  readonly rewriteMs?: number;
  readonly rewriteTokens?: { input: number; output: number };
}

interface RunSummary {
  readonly rerankEnabled: boolean;
  readonly questions: number;
  readonly recallAt5: number;
  readonly mrrAt10: number;
  readonly trapRecallAt5: number | null;
  readonly citationValidity: number | null;
  readonly grounded: number | null;
  readonly correct: number | null;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * 검색 trace 에서 결과 파일에 남길 필드를 뽑는다.
 *
 * 지연시간은 **trace 의 단계별 합**으로 잰다. 바깥에서 스톱워치를 돌리면 judge 호출이나
 * 답변 생성이 섞여 들어가, "재작성을 켜니 느려졌다"의 원인이 재작성인지 다른 것인지
 * 구분할 수 없게 된다.
 */
function traceFields(trace: RetrieveTrace) {
  const { rewrite, embed, vector, keyword, rerank } = trace.ms;
  return {
    retrieveMs: rewrite + embed + vector + keyword + rerank,
    ...(trace.rewriteEnabled
      ? {
          queries: trace.queries,
          rewriteFailed: trace.rewriteFailed,
          rewriteFromCache: trace.rewriteFromCache,
          rewriteMs: rewrite,
          rewriteTokens: trace.rewriteTokens,
        }
      : {}),
  };
}

function pct(x: number | null): string {
  return x === null ? "—" : x.toFixed(3);
}

async function runCondition(
  questions: readonly EvalQuestion[],
  gold: Map<string, readonly number[]>,
  rerankEnabled: boolean,
  retrievalOnly: boolean,
): Promise<{ summary: RunSummary; results: QuestionResult[] }> {
  const results: QuestionResult[] = [];

  for (const [i, q] of questions.entries()) {
    const goldIds = gold.get(q.id) ?? [];
    process.stdout.write(`  [${i + 1}/${questions.length}] ${q.id} `);

    if (retrievalOnly) {
      const { chunks, trace } = await retrieve(q.question, { topN: EVAL_TOP_N, rerankEnabled });
      const ids = chunks.map((c) => c.id);
      const r = recallAtK(ids, goldIds, RECALL_K);
      results.push({
        id: q.id,
        question: q.question,
        trap: q.trap,
        goldChunkIds: goldIds,
        retrievedIds: ids,
        recallAt5: r,
        mrrAt10: mrrAtK(ids, goldIds, MRR_K),
        ...traceFields(trace),
      });
      console.log(r === 1 ? "✓" : "✗");
      continue;
    }

    const res = await answerQuestion(q.question, { topN: EVAL_TOP_N, rerankEnabled });
    const ids = res.retrieved.map((c) => c.id);
    const trace = res.trace;
    const verdict = await judge({
      question: q.question,
      excerpts: res.retrieved,
      answer: res.answer.text,
      referenceAnswer: q.expected_answer,
    });

    const citationsTotal = res.answer.cited.length + res.answer.hallucinated.length;
    const r = recallAtK(ids, goldIds, RECALL_K);
    results.push({
      id: q.id,
      question: q.question,
      trap: q.trap,
      goldChunkIds: goldIds,
      retrievedIds: ids,
      recallAt5: r,
      mrrAt10: mrrAtK(ids, goldIds, MRR_K),
      citationsTotal,
      citationsHallucinated: res.answer.hallucinated.length,
      verdict,
      answer: res.answer.text,
      ...traceFields(trace),
    });
    console.log(`${r === 1 ? "✓" : "✗"} grounded=${verdict.grounded ? "✓" : "✗"} correct=${verdict.correct ? "✓" : "✗"}`);
  }

  const traps = results.filter((r) => r.trap);
  const withCitations = results.filter((r) => r.citationsTotal !== undefined && r.citationsTotal > 0);
  const judged = results.filter((r) => r.verdict);

  return {
    summary: {
      rerankEnabled,
      questions: results.length,
      recallAt5: mean(results.map((r) => r.recallAt5)),
      mrrAt10: mean(results.map((r) => r.mrrAt10)),
      trapRecallAt5: traps.length > 0 ? mean(traps.map((r) => r.recallAt5)) : null,
      citationValidity:
        withCitations.length > 0
          ? mean(withCitations.map((r) => 1 - r.citationsHallucinated! / r.citationsTotal!))
          : null,
      grounded: judged.length > 0 ? mean(judged.map((r) => (r.verdict!.grounded ? 1 : 0))) : null,
      correct: judged.length > 0 ? mean(judged.map((r) => (r.verdict!.correct ? 1 : 0))) : null,
    },
    results,
  };
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const retrievalOnly = process.argv.includes("--retrieval-only");
  const only = argValue("--only")?.split(",").map((s) => s.trim());

  /*
   * 질문 세트를 바꿔 끼울 수 있게 한다.
   *
   *   questions.yaml          사용자가 실제로 묻는 방식 — 정확한 식별자를 모르는 상태
   *   questions-literal.yaml  파라미터 이름을 그대로 넣은 방식
   *
   * 같은 사실을 두 방식으로 물어보면 리랭킹의 값어치가 어디서 나오는지가 드러난다.
   * 첫 측정에서 literal 세트는 26개 중 17개가 벡터 검색만으로 이미 1위였다 —
   * 질문에 정답 용어가 들어 있으면 리랭커가 고칠 게 없다.
   */
  const questionsFile = argValue("--questions") ?? "questions.yaml";
  const raw = await readFile(path.join(HERE, questionsFile), "utf8");
  const doc = loadYaml(raw) as { questions?: unknown[] };
  const list = Array.isArray(doc?.questions) ? doc.questions : [];
  if (list.length === 0) throw new Error("eval/questions.yaml 에 질문이 없습니다.");

  const all = list.map((q, i) => validateQuestion(q, i));

  // 검증 안 된 질문은 실행 자체를 막는다 (AGENTS.md §1 "거짓 수치 금지").
  const unverified = all.filter((q) => !q.verified);
  if (unverified.length > 0) {
    throw new Error(
      `정답이 실행으로 검증되지 않은 질문이 ${unverified.length}개 있습니다:\n` +
        unverified.map((q) => `  ${q.id}  (verified_by: ${q.verified_by || "비어 있음"})`).join("\n") +
        `\n\n띄워둔 Postgres 에 직접 확인한 뒤 verified: true 로 바꾸세요. 확인 못 할 질문은 세트에서 빼세요.`,
    );
  }

  const questions = only ? all.filter((q) => only.includes(q.id)) : all;
  if (questions.length === 0) throw new Error(`--only 로 지정한 질문을 찾지 못했습니다: ${only?.join(",")}`);

  console.log(`질문 ${questions.length}개 · 함정 질문 ${questions.filter((q) => q.trap).length}개`);
  const gold = await resolveGold(questions);
  console.log(`정답 라벨 해석 완료\n`);

  const runs: { summary: RunSummary; results: QuestionResult[] }[] = [];
  for (const rerankEnabled of [false, true]) {
    console.log(`── 리랭킹 ${rerankEnabled ? "ON" : "OFF"} ──`);
    runs.push(await runCondition(questions, gold, rerankEnabled, retrievalOnly));
    console.log();
  }

  const [off, on] = runs as [typeof runs[number], typeof runs[number]];

  const table = [
    `| 지표 | 리랭킹 OFF | 리랭킹 ON |`,
    `|---|---|---|`,
    `| recall@5 | ${pct(off.summary.recallAt5)} | ${pct(on.summary.recallAt5)} |`,
    `| MRR@10 | ${pct(off.summary.mrrAt10)} | ${pct(on.summary.mrrAt10)} |`,
    `| recall@5 (함정 질문만) | ${pct(off.summary.trapRecallAt5)} | ${pct(on.summary.trapRecallAt5)} |`,
    `| citation validity | ${pct(off.summary.citationValidity)} | ${pct(on.summary.citationValidity)} |`,
    `| grounded (근거 뒷받침) | ${pct(off.summary.grounded)} | ${pct(on.summary.grounded)} |`,
    `| correct (정답 일치) | ${pct(off.summary.correct)} | ${pct(on.summary.correct)} |`,
  ].join("\n");

  console.log(table);

  /*
   * 재작성의 대가를 같이 낸다.
   *
   * **이득만 적고 비용을 안 적으면 그 표는 거짓말이다.** 재작성은 질의당 LLM 호출을
   * 하나 더 붙이는 기법이라 지연시간과 토큰이 늘고, 그게 클라이언트에게는 실제 청구서다.
   *
   * 지연시간 평균은 **실제 호출이 일어난 건만** 센다. 재작성은 프로세스 안에서 캐시되므로
   * 두 번째 조건(리랭킹 ON)은 0ms 로 돌아온다 — 그걸 평균에 넣으면 비용이 절반으로 보인다.
   */
  const costBlock = ((): string => {
    if (!config.rewriteEnabled) return "";

    /*
     * **질문당 한 번만 센다.** 재작성은 질문 단위이고 리랭킹 OFF/ON 두 조건이 같은 결과를
     * 재사용하므로, 두 조건을 합쳐서 세면 비용이 정확히 두 배로 보인다.
     */
    const per = off.results;
    const fresh = per.filter((r) => r.rewriteFromCache === false);
    const cached = per.filter((r) => r.rewriteFromCache === true);
    const failed = per.filter((r) => r.rewriteFailed);
    const inTok = per.reduce((a, r) => a + (r.rewriteTokens?.input ?? 0), 0);
    const outTok = per.reduce((a, r) => a + (r.rewriteTokens?.output ?? 0), 0);

    const lines = [
      `쿼리 재작성 비용 (질문 ${per.length}개 · 이번 실행에서 호출 ${fresh.length}회, 캐시에서 읽음 ${cached.length}회)`,
    ];
    if (cached.length > 0) {
      lines.push(`  ※ 캐시 항목의 지연시간·토큰은 최초 호출 때 기록된 실측값이다 (추정치 아님).`);
    }
    lines.push(
      `  재작성 지연시간 평균 ${mean(per.map((r) => r.rewriteMs ?? 0)).toFixed(0)}ms / ` +
        `최대 ${Math.max(0, ...per.map((r) => r.rewriteMs ?? 0)).toFixed(0)}ms`,
      `  검색 전체 지연시간 평균 ${mean(off.results.map((r) => r.retrieveMs ?? 0)).toFixed(0)}ms (리랭킹 OFF) / ` +
        `${mean(on.results.map((r) => r.retrieveMs ?? 0)).toFixed(0)}ms (ON)`,
      `  토큰 입력 ${inTok} · 출력 ${outTok} (질문당 평균 입력 ${Math.round(inTok / per.length)})`,
      `  재작성 실패 ${failed.length}건${failed.length > 0 ? ` (${failed.map((r) => r.id).join(", ")})` : ""}`,
    );
    return `\n${lines.join("\n")}`;
  })();
  if (costBlock) console.log(costBlock);

  const failures = on.results.filter((r) => r.recallAt5 === 0 || r.verdict?.grounded === false);
  if (failures.length > 0) {
    console.log(`\n실패 ${failures.length}건 (리랭킹 ON):`);
    for (const f of failures) {
      console.log(`  ${f.id}  recall@5=${f.recallAt5}  ${f.verdict?.reason ?? ""}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `${stamp}.json`);
  await writeFile(
    outPath,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        mode: retrievalOnly ? "retrieval-only" : "full",
        // 어느 질문 세트로 낸 숫자인지 남기지 않으면 결과 파일끼리 비교할 수 없다.
        questionSet: questionsFile,
        config: { ...snapshotConfig(), evalTopN: EVAL_TOP_N, recallK: RECALL_K, mrrK: MRR_K },
        summary: { rerankOff: off.summary, rerankOn: on.summary },
        results: { rerankOff: off.results, rerankOn: on.results },
      },
      null,
      2,
    ),
    "utf8",
  );

  /*
   * 질문 세트마다, 그리고 **검색 구성마다** 다른 파일로 쓴다.
   *
   * 하나로 쓰면 나중에 돌린 조건이 앞의 결과를 덮는다. 하이브리드/재작성을 켜고 돌린
   * 결과가 기본 구성의 요약을 지워버리면, 비교하려고 낸 숫자가 비교 대상을 없앤 셈이 된다.
   */
  const variant = [
    config.hybridEnabled ? "hybrid" : "",
    config.rewriteEnabled ? "rewrite" : "",
    // 재작성을 켠 상태에서만 의미가 있고, 기본값이면 파일명을 지저분하게 하지 않는다.
    config.rewriteEnabled && config.rerankQuery !== "original" ? `rq-${config.rerankQuery}` : "",
  ]
    .filter(Boolean)
    .join("-");
  const summaryName = `latest-${questionsFile.replace(/\.ya?ml$/, "")}${variant ? `-${variant}` : ""}.md`;
  await writeFile(
    path.join(RESULTS_DIR, summaryName),
    `# 평가 결과\n\n실행 ${new Date().toISOString()} · 질문 ${questions.length}개 · 모드 ${retrievalOnly ? "retrieval-only" : "full"}\n\n` +
      `${table}\n${costBlock ? `\n\`\`\`\n${costBlock.trim()}\n\`\`\`\n` : ""}\n` +
      `설정: 청크 ${config.chunkTokens}토큰 / 오버랩 ${config.chunkOverlap} · 검색 top-${config.retrieveTopK} → 평가 top-${EVAL_TOP_N} · ` +
      `임베딩 ${config.embeddingModel} · 리랭커 ${config.rerankModel} · 답변 ${config.answerModel} (effort ${config.answerEffort}) · ` +
      `하이브리드 ${config.hybridEnabled ? "ON" : "OFF"} · 쿼리 재작성 ${config.rewriteEnabled ? `ON (${config.rewriteModel}, 최대 ${config.rewriteMaxQueries}개, 리랭크 질의 ${config.rerankQuery})` : "OFF"}\n\n` +
      `원본: \`${path.basename(outPath)}\`\n`,
    "utf8",
  );

  console.log(`\n저장: eval/results/${path.basename(outPath)}`);
  console.log(`요약: eval/results/${summaryName}`);
}

main()
  .catch((err) => {
    console.error(formatError(err));
    process.exitCode = 1;
  })
  .finally(closeDb);
