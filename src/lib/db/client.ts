import pg from "pg";
import { config } from "../config.ts";

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: config.databaseUrl() });
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * pgvector 는 vector 리터럴을 `[1,2,3]` 형태 문자열로 받는다.
 * 배열을 그대로 바인딩하면 Postgres 배열로 해석돼 타입 에러가 난다.
 */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.join(",")}]`;
}
