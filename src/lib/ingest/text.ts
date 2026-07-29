import { compactPath } from "./html.ts";
import type { Block, ParsedDoc } from "./types.ts";

/** plain text: 빈 줄로 문단을 나눈다. 헤딩 개념이 없으므로 headingPath 는 비운다. */
export function parseText(text: string, title: string): ParsedDoc {
  const blocks: Block[] = text
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
export function parseMarkdown(md: string, title: string): ParsedDoc {
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
