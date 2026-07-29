export type DocFormat = "html" | "pdf" | "md" | "txt" | "docx";

/**
 * 파서가 내놓는 최소 단위. 청킹이 문단/헤딩 경계를 인식하려면
 * 파서 단계에서 그 경계 정보를 잃지 않아야 한다 (AGENTS.md §5 2단계).
 */
export interface Block {
  /** 이 블록이 속한 헤딩 경로. 예: ["Server Configuration", "Resource Consumption", "Memory"] */
  readonly headingPath: readonly string[];
  readonly text: string;
}

export interface ParsedDoc {
  readonly title: string;
  readonly format: DocFormat;
  readonly blocks: readonly Block[];
}

/**
 * 토큰 수 근사.
 *
 * Voyage 는 공개 토크나이저를 제공하지 않는다. 청크 크기는 "대략 이 정도"면 되는 값이고
 * (임베딩 모델의 하드 리밋만 넘지 않으면 된다) 정확한 카운트가 필요한 곳이 없다.
 * 영문 기술문서 기준 1 토큰 ≈ 4 문자로 잡는다. **이 값은 근사임을 포트폴리오에도 적는다.**
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
