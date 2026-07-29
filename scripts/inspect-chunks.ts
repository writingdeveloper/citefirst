/**
 * 특정 문서의 청킹 결과를 눈으로 본다. DB 도 키도 필요 없다.
 *
 * 청킹은 검색 품질을 좌우하는데 **eval 을 돌리기 전까지는 숫자로 안 보인다.**
 * 그 사이를 이 스크립트가 메운다 — 예를 들어 `work_mem` 설명과 `maintenance_work_mem`
 * 설명이 한 청크에 뭉쳐 있으면, 그 코퍼스에서는 두 질문을 절대 구분할 수 없다.
 *
 *   npx tsx scripts/inspect-chunks.ts runtime-config-resource.html
 *   npx tsx scripts/inspect-chunks.ts runtime-config-resource.html --grep work_mem
 *   npx tsx scripts/inspect-chunks.ts runtime-config-resource.html --full
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/lib/config.ts";
import { chunkDoc } from "../src/lib/ingest/chunk.ts";
import { formatOf, parseFile } from "../src/lib/ingest/index.ts";
import { formatError } from "../src/lib/errors.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus");

async function find(name: string): Promise<string | null> {
  const walk = async (d: string): Promise<string | null> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const f = await walk(p);
        if (f) return f;
      } else if (e.name === name) return p;
    }
    return null;
  };
  return walk(CORPUS);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = process.argv[2];
  if (!name || name.startsWith("--")) {
    throw new Error(`파일명을 주세요.  예: npx tsx scripts/inspect-chunks.ts runtime-config-resource.html`);
  }
  const grep = argValue("--grep");
  const full = process.argv.includes("--full");

  const file = await find(name);
  if (!file) throw new Error(`corpus/ 에서 ${name} 을 찾지 못했습니다. npm run corpus:fetch 를 먼저 실행하세요.`);

  const format = formatOf(file);
  if (!format) throw new Error(`지원하지 않는 포맷: ${file}`);

  const doc = await parseFile(file, format);
  const chunks = chunkDoc(doc, { maxTokens: config.chunkTokens, overlapTokens: config.chunkOverlap });

  console.log(`${doc.title}`);
  console.log(`${path.relative(ROOT, file)} · 블록 ${doc.blocks.length} → 청크 ${chunks.length}`);
  console.log(`설정: ${config.chunkTokens} 토큰 / 오버랩 ${config.chunkOverlap}\n`);

  const shown = grep ? chunks.filter((c) => c.content.toLowerCase().includes(grep.toLowerCase())) : chunks;
  if (grep) console.log(`"${grep}" 포함 청크 ${shown.length}/${chunks.length}개\n`);

  for (const c of shown) {
    console.log(`── #${c.position} · ${c.tokenCount} 토큰 · ${c.headingPath.join(" > ") || "(헤딩 없음)"}`);
    console.log(full ? c.content : `${c.content.slice(0, 260).replace(/\n+/g, " ⏎ ")}…`);
    console.log();
  }

  const sizes = chunks.map((c) => c.tokenCount).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  const over = chunks.filter((c) => c.tokenCount > config.chunkTokens).length;
  console.log(`토큰 분포: 최소 ${sizes[0]} · 중앙 ${median} · 최대 ${sizes.at(-1)} · 예산 초과 ${over}개`);
  // 아주 작은 청크가 많으면 헤딩마다 잘리고 있다는 뜻이고, 그런 조각은 검색에서 잘 안 잡힌다.
  const tiny = chunks.filter((c) => c.tokenCount < 40).length;
  if (tiny > 0) console.log(`40 토큰 미만 청크 ${tiny}개 — 너무 잘게 쪼개졌는지 확인하세요.`);
}

main().catch((err) => {
  console.error(formatError(err));
  process.exitCode = 1;
});
