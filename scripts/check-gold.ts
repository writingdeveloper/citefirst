/**
 * eval 정답 라벨이 실제 코퍼스와 맞는지 **DB 없이** 미리 검증한다.
 *
 * eval/gold.ts 의 resolveGold 는 같은 일을 DB에 대고 하는데, 그건 ingest 를 다 끝낸 뒤에야
 * 돌릴 수 있다. 라벨이 틀렸다는 걸 그때 알면 8분짜리 ingest 를 다시 돌려야 한다.
 * 여기서는 파일을 직접 청킹해서 같은 조건으로 대조한다.
 *
 *   npx tsx scripts/check-gold.ts
 *
 * 판정 기준은 resolveGold 와 같다: 매칭 0건이면 라벨이 코퍼스와 안 맞는 것이고,
 * 너무 많이 매칭되면(>8) 라벨이 느슨해서 recall 이 후하게 나온다.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { config } from "../src/lib/config.ts";
import { chunkDoc } from "../src/lib/ingest/chunk.ts";
import { formatOf, parseFile } from "../src/lib/ingest/index.ts";
import { validateQuestion } from "../eval/schema.ts";
import { formatError } from "../src/lib/errors.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus");

interface IndexedChunk {
  sourcePath: string;
  headingPath: string;
  content: string;
}

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
  const raw = await readFile(path.join(ROOT, "eval", "questions.yaml"), "utf8");
  const doc = loadYaml(raw) as { questions?: unknown[] };
  const questions = (doc.questions ?? []).map((q, i) => validateQuestion(q, i));

  // 라벨이 가리키는 문서만 청킹한다. 전체를 돌 필요가 없다.
  const needles = new Set(questions.map((q) => q.gold.source_path_contains).filter(Boolean));
  const files = (await collect(CORPUS))
    .filter((f) => formatOf(f) !== null)
    .filter((f) => [...needles].some((n) => f.replaceAll("\\", "/").toLowerCase().includes(n.toLowerCase())));

  const index: IndexedChunk[] = [];
  for (const f of files) {
    const parsed = await parseFile(f, formatOf(f)!);
    const cs = chunkDoc(parsed, { maxTokens: config.chunkTokens, overlapTokens: config.chunkOverlap });
    const sourcePath = path.relative(CORPUS, f).replaceAll("\\", "/");
    for (const c of cs) {
      index.push({ sourcePath, headingPath: c.headingPath.join(" > "), content: c.content });
    }
  }

  console.log(`질문 ${questions.length}개 · 라벨이 가리키는 문서 ${files.length}개 · 청크 ${index.length}개\n`);

  let bad = 0;
  let loose = 0;
  for (const q of questions) {
    const matches = index.filter(
      (c) =>
        c.sourcePath.toLowerCase().includes(q.gold.source_path_contains.toLowerCase()) &&
        // eval/gold.ts 의 SQL 과 같은 조건: 헤딩 + 본문을 합쳐서 본다.
        q.gold.must_contain.every((n) => `${c.headingPath} ${c.content}`.toLowerCase().includes(n.toLowerCase())),
    );

    if (matches.length === 0) {
      bad++;
      console.log(`✗ ${q.id}  매칭 0건 — ${q.question}`);
      console.log(`    source~"${q.gold.source_path_contains}" must_contain=${JSON.stringify(q.gold.must_contain)}`);
      // 어느 조건이 걸렸는지 알려준다. 파일이 없는 건지 문자열이 없는 건지가 완전히 다른 문제다.
      const fileHits = index.filter((c) =>
        c.sourcePath.toLowerCase().includes(q.gold.source_path_contains.toLowerCase()),
      );
      if (fileHits.length === 0) {
        console.log(`    → 그 이름의 문서를 코퍼스에서 못 찾음`);
      } else {
        for (const n of q.gold.must_contain) {
          const hit = fileHits.filter((c) =>
            `${c.headingPath} ${c.content}`.toLowerCase().includes(n.toLowerCase()),
          ).length;
          console.log(`    → "${n}" 포함 청크 ${hit}개 / 문서 내 ${fileHits.length}개`);
        }
      }
      console.log();
      continue;
    }

    if (matches.length > 8) {
      loose++;
      console.log(`△ ${q.id}  매칭 ${matches.length}건 — 라벨이 느슨합니다 (must_contain 을 좁히세요)`);
      continue;
    }

    console.log(`✓ ${q.id}  매칭 ${matches.length}건 — ${matches[0]!.headingPath || matches[0]!.sourcePath}`);
  }

  console.log(`\n정상 ${questions.length - bad - loose} · 실패 ${bad} · 느슨함 ${loose}`);
  if (bad > 0) {
    console.log(`\n실패한 라벨을 고치기 전에는 eval 이 의미 있는 숫자를 내지 못합니다.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(formatError(err));
  process.exitCode = 1;
});
