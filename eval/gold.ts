import { db } from "../src/lib/db/client.ts";
import type { EvalQuestion } from "./schema.ts";

export interface ResolvedGold {
  readonly questionId: string;
  readonly chunkIds: readonly number[];
}

/**
 * 라벨(내용 명세)을 현재 DB 의 chunk ID 로 해석한다.
 *
 * 매칭이 0건이면 **에러로 끝낸다.** 조용히 0점으로 처리하면 "recall 이 낮다"로 보이지만
 * 실제로는 라벨이 코퍼스와 안 맞는 것이다. 두 상황을 구분하지 못하면 개선 방향을 못 잡는다.
 */
export async function resolveGold(questions: readonly EvalQuestion[]): Promise<Map<string, readonly number[]>> {
  const pool = db();
  const out = new Map<string, readonly number[]>();
  const problems: string[] = [];

  for (const q of questions) {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q.gold.source_path_contains) {
      params.push(`%${q.gold.source_path_contains}%`);
      conditions.push(`d.source_path ILIKE $${params.length}`);
    }
    for (const needle of q.gold.must_contain) {
      params.push(`%${needle}%`);
      /*
       * 헤딩을 같이 본다. 설정 파라미터 문서에서는 이름이 <dt>(→ heading_path)에만 있고
       * 본문에는 "It defaults to -1" 처럼 이름 없이 나온다. content 만 보면
       * autovacuum_work_mem 청크를 이름으로 특정할 수가 없다.
       * 임베딩에 넣는 텍스트(embedText)도 헤딩 + 본문이므로 관점이 일치한다.
       */
      conditions.push(`(coalesce(c.heading_path, '') || ' ' || c.content) ILIKE $${params.length}`);
    }

    const res = await pool.query<{ id: string }>(
      `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.doc_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY c.id`,
      params,
    );

    const ids = res.rows.map((r) => Number(r.id));
    if (ids.length === 0) {
      problems.push(
        `  ${q.id}: 정답 청크를 못 찾음 — source_path~"${q.gold.source_path_contains}", must_contain=${JSON.stringify(q.gold.must_contain)}`,
      );
    } else if (ids.length > 8) {
      // 너무 많이 매칭되면 라벨이 느슨한 것이다. 이 상태의 recall 은 후하게 나온다.
      problems.push(`  ${q.id}: 정답 청크가 ${ids.length}개나 매칭됨 — must_contain 을 좁히세요`);
    }
    out.set(q.id, ids);
  }

  if (problems.length > 0) {
    throw new Error(`정답 라벨 해석 실패:\n${problems.join("\n")}\n\n라벨을 고치거나 코퍼스를 다시 ingest 하세요.`);
  }
  return out;
}

export function recallAtK(retrieved: readonly number[], gold: readonly number[], k: number): number {
  const top = retrieved.slice(0, k);
  return gold.some((g) => top.includes(g)) ? 1 : 0;
}

/** 첫 정답 청크의 순위 역수. 상위 k 안에 없으면 0. */
export function mrrAtK(retrieved: readonly number[], gold: readonly number[], k: number): number {
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    if (gold.includes(retrieved[i]!)) return 1 / (i + 1);
  }
  return 0;
}
