/**
 * 마이그레이션 실행기.
 *
 * src/lib/db/migrations/*.sql 를 파일명 순서대로 적용하고 schema_migrations 에 기록한다.
 * 이미 적용된 것은 건너뛴다. 각 파일은 하나의 트랜잭션으로 돈다.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./_env.ts";
import { db, closeDb } from "../src/lib/db/client.ts";
import { formatError } from "../src/lib/errors.ts";

loadEnv();

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
  "db",
  "migrations",
);

async function main() {
  const pool = db();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`  apply ${file}`);
      ran++;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`마이그레이션 실패: ${file}\n${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }

  // 1단계 확인 조건: 빈 테이블이 조회된다.
  const counts = await pool.query<{ documents: string; chunks: string }>(
    "SELECT (SELECT count(*) FROM documents) AS documents, (SELECT count(*) FROM chunks) AS chunks",
  );
  const row = counts.rows[0]!;
  console.log(`\n적용 ${ran}건 · documents=${row.documents} chunks=${row.chunks}`);
}

main()
  .catch((err) => {
    console.error(formatError(err));
    process.exitCode = 1;
  })
  .finally(closeDb);
