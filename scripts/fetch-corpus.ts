/**
 * PostgreSQL 17 문서를 corpus/ 로 내려받는다.
 *
 * 받는 것 (AGENTS.md §4):
 *   1. postgresql-17.10-docs.tar.gz  (~3.6 MB)  HTML — 검색 코퍼스 본체
 *   2. COPYRIGHT                      (~1.2 KB)  라이선스 원문. SOURCES.md 에 옮길 근거
 *   3. README                         (~1.5 KB)  plain text 파서용
 *   4. postgresql-17-A4.pdf          (~15.4 MB)  PDF 파서 검증 전용 (--with-pdf 일 때만)
 *
 * PDF 를 기본에서 뺀 이유: HTML 과 **같은 내용**이라 둘 다 ingest 하면 중복 청크가 생기고
 * eval 정답 라벨이 둘로 쪼개진다. PDF 파서는 scripts/parser-check.ts 에서 별도로 증명한다.
 * (docs/decisions.md D10)
 *
 * 코퍼스 파일은 커밋하지 않는다 (.gitignore).
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { formatError } from "../src/lib/errors.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus");

const PG_VERSION = "17.10";
const BASE = `https://ftp.postgresql.org/pub/source/v${PG_VERSION}`;
const RAW = `https://raw.githubusercontent.com/postgres/postgres/REL_${PG_VERSION.replace(".", "_")}`;

interface Target {
  readonly url: string;
  readonly dest: string;
  readonly note: string;
  readonly optional?: boolean;
}

const TARGETS: readonly Target[] = [
  { url: `${BASE}/postgresql-${PG_VERSION}-docs.tar.gz`, dest: "postgresql-docs.tar.gz", note: "HTML 문서 타르볼" },
  // 확장자가 없어 txt 파서로 들어간다 — plain text 커버리지가 여기서 나온다.
  { url: `${RAW}/COPYRIGHT`, dest: "raw/COPYRIGHT", note: "라이선스 원문 (txt 파서용)" },
  // postgres 레포의 README 는 17.x 시점에 README.md 로 바뀌었다. Markdown 커버리지를 겸한다.
  { url: `${RAW}/README.md`, dest: "raw/README.md", note: "Markdown 파서용" },
  {
    url: `https://www.postgresql.org/files/documentation/pdf/17/postgresql-17-A4.pdf`,
    dest: "pdf/postgresql-17-A4.pdf",
    note: "PDF 파서 검증 전용 (ingest 하지 않음)",
    optional: true,
  },
];

async function download(t: Target): Promise<{ bytes: number; sha256: string }> {
  const res = await fetch(t.url);
  if (!res.ok) throw new Error(`${t.url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(CORPUS, t.dest);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

/** Windows 10+ / macOS / Linux 모두 tar 가 있다. gz 는 어디서나 지원된다. */
async function extractDocs(): Promise<number> {
  const out = path.join(CORPUS, "html");
  await mkdir(out, { recursive: true });
  try {
    // 절대 경로를 넘기면 GNU tar 가 "C:" 를 원격 호스트로 해석해 실패한다
    // (Git Bash 의 tar 에서 실제로 발생). cwd 를 옮기고 상대 경로로 부른다.
    await execFileAsync("tar", ["-xzf", path.join("..", "postgresql-docs.tar.gz")], { cwd: out });
  } catch (err) {
    throw new Error(
      `tar 해제 실패. tar 가 PATH 에 있는지 확인하세요.\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // 타르볼은 postgresql-17.10/doc/... 처럼 한 겹 감싸서 나온다. 실제 html 디렉터리를 찾는다.
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".html")) count++;
    }
  };
  await walk(out);
  return count;
}

async function main() {
  const withPdf = process.argv.includes("--with-pdf");
  await mkdir(CORPUS, { recursive: true });

  console.log(`PostgreSQL ${PG_VERSION} 문서를 corpus/ 로 받습니다.\n`);
  const records: string[] = [];

  for (const t of TARGETS) {
    if (t.optional && !withPdf) {
      console.log(`  skip  ${t.dest}  (--with-pdf 로 받을 수 있음 — ${t.note})`);
      continue;
    }
    const dest = path.join(CORPUS, t.dest);
    if (existsSync(dest)) {
      const s = await stat(dest);
      console.log(`  have  ${t.dest}  ${(s.size / 1024 / 1024).toFixed(2)} MB`);
      continue;
    }
    process.stdout.write(`  get   ${t.dest} …`);
    const { bytes, sha256 } = await download(t);
    console.log(` ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    records.push(`| ${t.dest} | ${t.url} | ${bytes} | \`${sha256.slice(0, 16)}…\` |`);
  }

  const htmlCount = await extractDocs();
  console.log(`\nHTML 파일 ${htmlCount}개 해제됨 → corpus/html/`);

  if (records.length > 0) {
    console.log(`\ncorpus/SOURCES.md 에 옮길 기록:\n`);
    console.log(`| 파일 | URL | bytes | sha256 |`);
    console.log(`|---|---|---|---|`);
    for (const r of records) console.log(r);
  }
  console.log(`\n다음: corpus/raw/COPYRIGHT 를 열어 전문을 corpus/SOURCES.md 의 "라이선스 원문"에 옮기세요.`);
}

main().catch((err) => {
  console.error(formatError(err));
  process.exitCode = 1;
});
