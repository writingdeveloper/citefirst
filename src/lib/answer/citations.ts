import type { RetrievedChunk } from "../retrieve/index.ts";

export interface VerifiedCitation {
  readonly id: number;
  readonly sourcePath: string;
  readonly docTitle: string;
  readonly headingPath: string | null;
  readonly content: string;
}

export interface CitationCheck {
  /** 검증에 실패한 인용을 제거한 답변 텍스트. UI 는 이 값만 렌더링한다. */
  readonly text: string;
  readonly cited: readonly VerifiedCitation[];
  /** 모델이 만들어낸, 실제로는 존재하지 않는 ID. 지우지 말고 세어서 eval 에 남긴다. */
  readonly hallucinated: readonly string[];
}

const CITE_RE = /\[c(\d+)\]/g;

/**
 * 인용 검증 (D6).
 *
 * 모델이 뱉은 `[c123]` 을 그대로 화면에 띄우면 확인할 수 없는 인용을 확인 가능한 척 노출하게 된다.
 * 여기서 **검색에 실제로 사용된 청크 목록과 대조**해, 매칭된 것만 남긴다.
 *
 * 대조 대상이 DB 전체가 아니라 "이번 요청에 넣어준 청크"인 점이 중요하다.
 * 모델은 자기가 받지 않은 청크를 인용할 수 없어야 한다 — 받지 않은 ID 를 맞혔다면
 * 그건 근거를 읽은 게 아니라 추측한 것이다.
 */
export function verifyCitations(text: string, provided: readonly RetrievedChunk[]): CitationCheck {
  const byId = new Map(provided.map((c) => [c.id, c]));
  const cited = new Map<number, VerifiedCitation>();
  const hallucinated: string[] = [];

  const cleaned = text.replace(CITE_RE, (match, digits: string) => {
    const id = Number(digits);
    const chunk = byId.get(id);
    if (!chunk) {
      hallucinated.push(match);
      return ""; // 검증 실패한 인용은 화면에서 제거한다.
    }
    cited.set(id, {
      id: chunk.id,
      sourcePath: chunk.sourcePath,
      docTitle: chunk.docTitle,
      headingPath: chunk.headingPath,
      content: chunk.content,
    });
    return match;
  });

  return {
    // 인용을 지우면서 생긴 이중 공백만 정리한다. 문장 구조는 건드리지 않는다.
    text: cleaned.replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:])/g, "$1"),
    cited: [...cited.values()],
    hallucinated,
  };
}
