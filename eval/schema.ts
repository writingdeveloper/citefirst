/**
 * 평가 질문 세트의 스키마.
 *
 * ## 왜 정답을 chunk ID 로 적지 않는가
 *
 * chunks.id 는 BIGSERIAL 이라 재수집할 때마다 바뀐다. 라벨에 ID 를 박아두면 청킹 설정을
 * 한 번만 바꿔도 세트 전체가 조용히 무효가 된다 — 그런데 숫자는 그대로 나오기 때문에
 * **틀린 줄도 모르고 포트폴리오에 쓰게 된다.**
 *
 * 그래서 정답을 "내용으로" 특정한다: 어느 문서의, 어떤 문자열을 담은 청크인가.
 * 이건 청킹을 바꿔도 살아남고, 실패하면 (매칭 0건) 즉시 드러난다.
 */
export interface GoldSpec {
  /** documents.source_path. 예: "html/postgresql-17.10/doc/src/sgml/html/runtime-config-resource.html" */
  readonly source_path_contains: string;
  /** 정답 청크가 반드시 전부 포함하는 문자열들. 대소문자 구분 없음. */
  readonly must_contain: readonly string[];
}

export interface EvalQuestion {
  readonly id: string;
  readonly question: string;
  /** 실행으로 확인한 정답. judge 가 correctness 를 채점할 때 기준이 된다. */
  readonly expected_answer: string;
  /**
   * 정답을 **어떻게** 확인했는지. 예: "SHOW work_mem;" / "\\d pg_settings"
   *
   * AGENTS.md §6 의 핵심 규칙이다. 이 필드가 비어 있으면 그 질문의 정답은 추측이고,
   * 추측으로 만든 라벨에서 나온 recall 수치는 아무 의미가 없다.
   */
  readonly verified_by: string;
  /**
   * 실제로 Postgres 에 물어서 확인했는가. **false 면 하네스가 실행을 거부한다.**
   * "나중에 확인하자"가 그대로 포트폴리오 숫자가 되는 경로를 코드로 막는다.
   */
  readonly verified: boolean;
  readonly gold: GoldSpec;
  /**
   * 혼동 지점을 노린 질문인지. 리랭킹 before/after 가 여기서 갈린다 (AGENTS.md §6).
   * 결과 표에서 이 그룹만 따로 집계한다.
   */
  readonly trap?: string;
}

export interface QuestionSet {
  readonly questions: readonly EvalQuestion[];
}

export function validateQuestion(q: unknown, index: number): EvalQuestion {
  const at = `questions[${index}]`;
  if (typeof q !== "object" || q === null) throw new Error(`${at}: 객체가 아닙니다`);
  const o = q as Record<string, unknown>;

  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`${at}.${k}: 비어 있습니다`);
    return v;
  };

  const gold = o["gold"];
  if (typeof gold !== "object" || gold === null) throw new Error(`${at}.gold: 없습니다`);
  const g = gold as Record<string, unknown>;
  const mustContain = g["must_contain"];
  if (!Array.isArray(mustContain) || mustContain.length === 0) {
    throw new Error(`${at}.gold.must_contain: 최소 1개가 필요합니다`);
  }

  return {
    id: str("id"),
    question: str("question"),
    expected_answer: str("expected_answer"),
    verified_by: str("verified_by"),
    verified: o["verified"] === true,
    gold: {
      source_path_contains: String(g["source_path_contains"] ?? ""),
      must_contain: mustContain.map(String),
    },
    trap: typeof o["trap"] === "string" ? o["trap"] : undefined,
  };
}
