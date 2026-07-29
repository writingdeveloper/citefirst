/**
 * corpus/ 를 ingest 한다.
 *
 *   npm run ingest                    기본 범위 (AGENTS.md §4)
 *   npm run ingest -- --all           corpus 전체
 *   npm run ingest -- --include "^sql-"   파일명 정규식으로 범위 지정
 *   npm run ingest -- --force         해시가 같아도 다시 넣는다
 *   npm run ingest -- --limit 50      앞의 N개만 (파이프라인 점검용)
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./_env.ts";
import { closeDb } from "../src/lib/db/client.ts";
import { formatOf, ingestFile } from "../src/lib/ingest/index.ts";
import { formatError } from "../src/lib/errors.ts";

loadEnv();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus");

/**
 * 기본 ingest 범위. DocBook 은 파일명에 섹션이 드러난다:
 *   runtime-config-*  Server Configuration
 *   sql-*             SQL Commands
 *   app-*             Client / Server Applications
 *   그 외             Server Administration 중 자주 쓰이는 장
 *
 * 이 범위 안에 혼동 지점(pg_dump/pg_dumpall, VACUUM/VACUUM FULL, *_work_mem)이 전부 들어있다.
 */
const DEFAULT_INCLUDE =
  /^(runtime-config|runtime-|sql-|app-|pgupgrade|backup|maintenance|monitoring|diskusage|wal|high-availability|auth-|client-auth|user-manag|ddl-|indexes-?|routine-|charset|locale|multibyte)/;

/** PDF 는 HTML 과 내용이 겹쳐서 검색 코퍼스에 넣지 않는다 (docs/decisions.md D10). */
const EXCLUDE_DIRS = new Set(["pdf"]);

async function collect(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      await collect(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  try {
    await stat(CORPUS);
  } catch {
    throw new Error(`corpus/ 가 없습니다. 먼저 실행하세요:  npm run corpus:fetch`);
  }

  const all = process.argv.includes("--all");
  const force = process.argv.includes("--force");
  const limitRaw = argValue("--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const includeRaw = argValue("--include");
  const include = includeRaw ? new RegExp(includeRaw) : all ? /.*/ : DEFAULT_INCLUDE;

  const files = (await collect(CORPUS))
    .filter((f) => formatOf(f) !== null)
    .filter((f) => path.basename(f) !== "SOURCES.md")
    .filter((f) => include.test(path.basename(f)))
    .sort();

  const targets = limit ? files.slice(0, limit) : files;

  if (targets.length === 0) {
    throw new Error(`ingest 대상이 없습니다. 범위 정규식: ${include}`);
  }

  console.log(`대상 ${targets.length}개 파일 (범위: ${all ? "전체" : include})\n`);

  const t0 = performance.now();
  let chunks = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, file] of targets.entries()) {
    const label = `[${i + 1}/${targets.length}] ${path.basename(file)}`;
    try {
      const res = await ingestFile(file, CORPUS, { force });
      if (res.skipped) {
        skipped++;
        console.log(`  ${label} — 변경 없음`);
      } else {
        chunks += res.chunks;
        console.log(`  ${label} — 청크 ${res.chunks}`);
      }
    } catch (err) {
      failed++;
      // 실패를 삼키지 않는다. 어떤 파일이 왜 실패했는지가 포트폴리오에 쓸 정보다.
      console.error(`  ${label} — 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n완료: 문서 ${targets.length - skipped - failed}개 · 청크 ${chunks}개 · 건너뜀 ${skipped} · 실패 ${failed} · ${secs}초`,
  );
  console.log(`이 수치를 docs/portfolio.md 에 기록하세요.`);
}

main()
  .catch((err) => {
    console.error(formatError(err));
    process.exitCode = 1;
  })
  .finally(closeDb);
