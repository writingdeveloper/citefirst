import type { Block, ParsedDoc } from "./types.ts";

/**
 * PDF 파서.
 *
 * PDF 에는 문서 구조가 없다 — 좌표에 놓인 텍스트 조각만 있다. 그래서
 * "문단 경계"를 y좌표 간격으로 **추정**해야 한다. 이 추정이 HTML 파싱보다 훨씬 부정확하고,
 * 그게 스캔 문서에는 OCR 이 따로 필요하다고 미리 밝혀둔 이유이기도 하다.
 *
 * 이 프로젝트에서 PDF 는 검색 코퍼스가 아니라 **파서 커버리지 증명용**이다
 * (docs/decisions.md D10). 대량 ingest 를 전제로 튜닝하지 않는다.
 */
export async function parsePdf(
  data: Uint8Array,
  title: string,
  opts: { maxPages?: number } = {},
): Promise<ParsedDoc> {
  // pdfjs 는 ESM 전용 빌드를 쓴다. 워커 없이 동작시키려면 legacy 빌드가 필요하다.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;

  const pageCount = Math.min(doc.numPages, opts.maxPages ?? doc.numPages);
  const blocks: Block[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    let line = "";
    let lastY: number | null = null;
    const paragraphs: string[] = [];

    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = item.transform[5] as number;
      // 줄바꿈 판정: y 가 눈에 띄게 바뀌면 새 줄.
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        if (line.trim()) paragraphs.push(line.trim());
        line = "";
      }
      line += item.str;
      if (item.hasEOL) line += " ";
      lastY = y;
    }
    if (line.trim()) paragraphs.push(line.trim());

    const text = paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length > 0) blocks.push({ headingPath: [`p.${i}`], text });
  }

  await loadingTask.destroy();
  return { title, format: "pdf", blocks };
}
