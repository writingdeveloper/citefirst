/**
 * ingest 규모와 소요 시간을 미리 잰다. **DB 없이 돈다.**
 *
 * 로컬 임베딩은 CPU 에서 돌기 때문에 코퍼스가 커지면 시간이 급격히 는다.
 * 몇 시간짜리 작업을 모르고 시작하는 걸 막고, 클라이언트에게 "얼마나 걸립니다"를
 * 말할 수 있게 하는 것도 이 스크립트의 목적이다.
 *
 *   npx tsx scripts/estimate-ingest.ts
 *   npx tsx scripts/estimate-ingest.ts --all
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/lib/config.ts";
import { chunkDoc } from "../src/lib/ingest/chunk.ts";
import { formatOf, parseFile } from "../src/lib/ingest/index.ts";
import { embedDocuments, warmup } from "../src/lib/embed/index.ts";
import { formatError } from "../src/lib/errors.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus");

// scripts/ingest.ts 의 DEFAULT_INCLUDE 와 같아야 한다.
const DEFAULT_INCLUDE =
  /^(runtime-config|runtime-|sql-|app-|pgupgrade|backup|maintenance|monitoring|diskusage|wal|high-availability|auth-|client-auth|user-manag|ddl-|indexes-?|routine-|charset|locale|multibyte)/;

async function collect(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "pdf") continue;
      await collect(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

async function main() {
  const all = process.argv.includes("--all");
  const include = all ? /.*/ : DEFAULT_INCLUDE;

  const files = (await collect(CORPUS))
    .filter((f) => formatOf(f) !== null)
    .filter((f) => path.basename(f) !== "SOURCES.md")
    .filter((f) => include.test(path.basename(f)))
    .sort();

  console.log(`대상 파일 ${files.length}개 (범위: ${all ? "전체" : "기본"})`);
  console.log(`청킹 중…`);

  let chunks = 0;
  let tokens = 0;
  /**
   * 처리량 측정에 쓸 **실제 청크** 표본.
   *
   * 인위적으로 만든 문자열("x".repeat(...))로 재면 안 된다 — 토크나이저가 반복 토큰을
   * 짧게 압축해서 실제보다 훨씬 빠른 숫자가 나온다. 실측에서 380배 차이가 났다.
   */
  const sample: string[] = [];
  const t0 = performance.now();
  for (const f of files) {
    const format = formatOf(f)!;
    try {
      const parsed = await parseFile(f, format);
      const cs = chunkDoc(parsed, { maxTokens: config.chunkTokens, overlapTokens: config.chunkOverlap });
      chunks += cs.length;
      for (const c of cs) {
        tokens += c.tokenCount;
        // 코퍼스 전체에서 고르게 뽑는다. 앞쪽만 쓰면 짧은 문서에 치우친다.
        if (sample.length < 32 && chunks % 40 === 0) sample.push(c.embedText);
      }
    } catch {
      // 파싱 실패는 여기서 무시한다. 실제 실패 목록은 ingest 가 보고한다.
    }
  }
  const parseMs = performance.now() - t0;
  console.log(`청크 ${chunks}개 · 약 ${(tokens / 1000).toFixed(0)}k 토큰 · 파싱+청킹 ${(parseMs / 1000).toFixed(1)}초\n`);

  console.log(`임베딩 처리량 측정 (모델 로딩은 제외)…`);
  await warmup();
  if (sample.length === 0) throw new Error("표본 청크를 못 모았습니다.");
  const t1 = performance.now();
  await embedDocuments(sample);
  const perChunk = (performance.now() - t1) / sample.length;

  const totalMin = (perChunk * chunks) / 1000 / 60;
  console.log(`  청크당 ${perChunk.toFixed(0)}ms\n`);
  console.log(`예상 ingest 시간: 약 ${totalMin.toFixed(0)}분 (${chunks}개 × ${perChunk.toFixed(0)}ms)`);
  if (totalMin > 45) {
    console.log(`\n  범위를 좁히는 걸 고려하세요:  npm run ingest -- --include "^(runtime-config|sql-vacuum|app-pg)"`);
    console.log(`  eval 질문이 다루는 문서만 넣어도 검색 난이도는 유지됩니다.`);
  }
}

main().catch((err) => {
  console.error(formatError(err));
  process.exitCode = 1;
});
