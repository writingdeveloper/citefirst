import mammoth from "mammoth";
import { parseHtml } from "./html.ts";
import type { ParsedDoc } from "./types.ts";

/**
 * DOCX 파서.
 *
 * mammoth 로 HTML 로 변환한 뒤 HTML 파서를 재사용한다. Word 의 "Heading 1" 스타일이
 * `<h1>` 으로 나오므로 헤딩 경계 인식이 그대로 살아난다 — 직접 XML 을 파싱하는 것보다
 * 구조 보존이 낫다.
 */
export async function parseDocx(buffer: Buffer, title: string): Promise<ParsedDoc> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const parsed = parseHtml(`<html><body>${html}</body></html>`);
  return { ...parsed, title, format: "docx" };
}
