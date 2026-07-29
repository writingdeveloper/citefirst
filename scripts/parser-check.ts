/**
 * 파서 커버리지 검증.
 *
 * 지원한다고 적은 포맷은 PDF, Word, Markdown, HTML, plain text 다섯 종이다.
 * 그 주장을 증명하려면 파서가 **실제 파일을 처리해 텍스트를 뽑는 걸** 보여야 한다.
 *
 * PDF 는 검색 코퍼스에 넣지 않는다 (HTML 과 내용이 겹쳐 중복 청크가 되고 eval 라벨이 쪼개진다 —
 * docs/decisions.md D10). 그래서 파서 증명을 여기서 따로 한다.
 *
 *   npm run corpus:fetch -- --with-pdf   먼저 PDF 를 받고
 *   npx tsx scripts/parser-check.ts      여기서 태운다
 */
import { existsSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/lib/config.ts";
import { chunkDoc } from "../src/lib/ingest/chunk.ts";
import { formatOf, parseFile } from "../src/lib/ingest/index.ts";
import type { DocFormat } from "../src/lib/ingest/types.ts";
import { formatError } from "../src/lib/errors.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus");

interface Row {
  format: DocFormat;
  file: string;
  bytes: number;
  blocks: number;
  chunks: number;
  ms: number;
  sample: string;
  ok: boolean;
  note?: string;
}

async function check(file: string, limitPages?: number): Promise<Row> {
  const format = formatOf(file);
  if (!format) throw new Error(`포맷을 알 수 없습니다: ${file}`);
  const size = (await stat(file)).size;
  const t0 = performance.now();

  try {
    const parsed = await parseFile(file, format);
    const chunks = chunkDoc(parsed, { maxTokens: config.chunkTokens, overlapTokens: config.chunkOverlap });
    const sample = (chunks[0]?.content ?? "").slice(0, 120).replace(/\s+/g, " ");
    return {
      format,
      file: path.relative(ROOT, file),
      bytes: size,
      blocks: parsed.blocks.length,
      chunks: chunks.length,
      ms: performance.now() - t0,
      sample,
      ok: chunks.length > 0 && sample.length > 20,
      note: limitPages ? `앞 ${limitPages}쪽만` : undefined,
    };
  } catch (err) {
    return {
      format,
      file: path.relative(ROOT, file),
      bytes: size,
      blocks: 0,
      chunks: 0,
      ms: performance.now() - t0,
      sample: "",
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function firstFile(dir: string, ext: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const walk = async (d: string): Promise<string | null> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const found = await walk(p);
        if (found) return found;
      } else if (e.name.toLowerCase().endsWith(ext)) return p;
    }
    return null;
  };
  return walk(dir);
}

async function main() {
  const targets: string[] = [];

  const html = await firstFile(path.join(CORPUS, "html"), ".html");
  if (html) targets.push(html);

  // 확장자가 없는 파일은 txt 파서로 간다. COPYRIGHT 가 그 경로를 태운다.
  const txt = path.join(CORPUS, "raw", "COPYRIGHT");
  if (existsSync(txt)) targets.push(txt);

  const pdf = await firstFile(path.join(CORPUS, "pdf"), ".pdf");
  if (pdf) targets.push(pdf);

  const md = path.join(ROOT, "README.md");
  if (existsSync(md)) targets.push(md);

  const docx = await firstFile(path.join(CORPUS, "fixtures"), ".docx");
  if (docx) targets.push(docx);

  if (targets.length === 0) {
    throw new Error(`검사할 파일이 없습니다. 먼저 실행하세요:  npm run corpus:fetch`);
  }

  const rows: Row[] = [];
  for (const t of targets) {
    process.stdout.write(`  ${path.basename(t)} … `);
    const row = await check(t);
    rows.push(row);
    console.log(row.ok ? `✓ 청크 ${row.chunks}개 (${row.ms.toFixed(0)}ms)` : `✗ ${row.note ?? "텍스트를 못 뽑음"}`);
  }

  const covered = new Set(rows.filter((r) => r.ok).map((r) => r.format));
  const missing = (["html", "pdf", "md", "txt", "docx"] as const).filter((f) => !covered.has(f));

  const md_ = [
    `# 파서 커버리지`,
    ``,
    `지원한다고 적은 포맷 5종(PDF, Word, Markdown, HTML, plain text)에 대한 실측 기록.`,
    `\`npx tsx scripts/parser-check.ts\` 로 재현한다.`,
    ``,
    `| 포맷 | 파일 | 크기 | 블록 | 청크 | 시간 | 결과 |`,
    `|---|---|---|---|---|---|---|`,
    ...rows.map(
      (r) =>
        `| ${r.format} | \`${r.file}\` | ${(r.bytes / 1024).toFixed(0)} KB | ${r.blocks} | ${r.chunks} | ${r.ms.toFixed(0)}ms | ${r.ok ? "✅" : `❌ ${r.note ?? ""}`} |`,
    ),
    ``,
    missing.length > 0
      ? `**미검증 포맷: ${missing.join(", ")}** — 파서 코드는 있지만 실제 파일로 태워보지 않았다. 검증 전에는 증명된 것으로 취급하지 않는다.`
      : `모든 포맷을 실제 파일로 검증했다.`,
    ``,
    `## 첫 청크 표본`,
    ``,
    ...rows.filter((r) => r.ok).flatMap((r) => [`**${r.format}** — \`${r.file}\``, ``, `> ${r.sample}…`, ``]),
  ].join("\n");

  await writeFile(path.join(ROOT, "docs", "parser-coverage.md"), md_, "utf8");
  console.log(`\n기록: docs/parser-coverage.md`);
  if (missing.length > 0) console.log(`미검증 포맷: ${missing.join(", ")}`);
}

main().catch((err) => {
  console.error(formatError(err));
  process.exitCode = 1;
});
