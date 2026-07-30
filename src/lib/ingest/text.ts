import { compactPath } from "./html.ts";
import type { Block, ParsedDoc } from "./types.ts";

/**
 * 줄바꿈을 LF 로 통일한다.
 *
 * **이걸 안 하면 CRLF 파일의 마크다운 헤딩이 전부 무시된다.** 아래 헤딩 정규식의 `$` 는
 * `\r` 앞에서 매칭되지 않기 때문이다(`.` 도 `\r` 을 먹지 않는다). 결과는 조용하다 —
 * 에러 없이 `headingPath` 가 전부 비고, `#` 줄이 본문으로 섞이고, 헤딩 경계가 사라져
 * 서로 다른 절이 한 청크에 뭉친다. 실측: 같은 `README.md` 가 LF 로는 블록 95 · 청크 24,
 * CRLF 로는 블록 114 · 청크 17 이 되고 첫 청크 본문이 `# citefirst …` 로 시작했다.
 *
 * Windows 에서 작성한 `.md`·`.txt` 는 CRLF 가 기본이므로 **클라이언트 문서에서 정상적으로
 * 일어나는 일**이다. 커밋돼 있던 `docs/parser-coverage.md` 가 실제로 이 상태로 생성돼 있었고,
 * 그 파일이 낡았다는 것을 눈치챈 것도 우연이었다 (D19).
 *
 * 홀로 있는 `\r`(옛 Mac 줄바꿈)도 같이 정규화한다.
 */
function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** plain text: 빈 줄로 문단을 나눈다. 헤딩 개념이 없으므로 headingPath 는 비운다. */
export function parseText(text: string, title: string): ParsedDoc {
  const blocks: Block[] = toLf(text)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+$/gm, "").trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ headingPath: [], text: p }));
  return { title, format: "txt", blocks };
}

/**
 * Markdown: ATX 헤딩(`#`)만 경계로 인식한다.
 * 코드 펜스 안의 `#` 은 헤딩이 아니므로 펜스 상태를 추적한다.
 */
export function parseMarkdown(source: string, title: string): ParsedDoc {
  const md = toLf(source);
  const blocks: Block[] = [];
  const headingPath: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (text.length > 0) blocks.push({ headingPath: compactPath(headingPath), text });
  };

  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }
    const h = !inFence ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (h) {
      flush();
      const level = h[1]!.length - 1;
      headingPath.length = Math.min(headingPath.length, level);
      headingPath[level] = h[2]!.trim();
      continue;
    }
    if (line.trim() === "" && !inFence) {
      const text = buffer.join("\n").trim();
      if (text.length > 0) blocks.push({ headingPath: compactPath(headingPath), text });
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  flush();

  const firstHeading = /^#\s+(.*)$/m.exec(md)?.[1]?.trim();
  return { title: firstHeading ?? title, format: "md", blocks };
}
