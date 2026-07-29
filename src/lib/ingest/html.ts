import { parse, type HTMLElement } from "node-html-parser";
import type { Block, ParsedDoc } from "./types.ts";

/**
 * PostgreSQL 문서 HTML(DocBook 생성물) 파서.
 *
 * DocBook 출력은 구조가 일정하다:
 *   - div.navheader / div.navfooter  → 페이지마다 반복되는 네비게이션. **반드시 버린다.**
 *     안 버리면 모든 청크에 "Prev / Up / Next" 가 섞여 임베딩이 오염되고,
 *     검색 결과가 내용이 아니라 네비게이션 유사도로 정렬되기 시작한다.
 *   - h1.title / h2.title / h3.title  → 섹션 경계
 *   - p, pre, table                   → 본문
 */

const DROP_SELECTORS = [
  "div.navheader",
  "div.navfooter",
  "script",
  "style",
  "hr",
  // DocBook 은 모든 제목·정의 항목 옆에 "#" 앵커 링크를 단다. 안 버리면 헤딩 경로가
  // "19.4. Resource Consumption #" 이 되고, 그 문자열이 embedText prefix 로 들어가 벡터를 오염시킨다.
  "a.id_link",
];
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4"]);
const TEXT_TAGS = new Set(["P", "PRE", "TABLE", "BLOCKQUOTE", "UL", "OL"]);

/*
 * HTML 소스의 줄바꿈은 **의미가 없다** — 편집자가 80칸에 맞춰 접어둔 것뿐이다.
 * 그대로 두면 `<code class="literal">ACCESS\n   EXCLUSIVE</code>` 가 텍스트에서도
 * 두 줄로 남아 "ACCESS EXCLUSIVE" 를 찾는 검색·라벨이 전부 빗나간다.
 * 문단 구분은 블록을 join 할 때 따로 넣으므로, 여기서는 모든 공백류를 하나로 만든다.
 * (PRE 는 이 함수를 타지 않는다 — 거기서는 공백이 의미를 가진다.)
 */
function clean(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** sparse 배열의 구멍을 없앤다. `[ , "A", "B"]` → `["A", "B"]` */
export function compactPath(p: readonly (string | undefined)[]): string[] {
  return Array.from(p).filter((s): s is string => typeof s === "string" && s.length > 0);
}

export function parseHtml(html: string): ParsedDoc {
  /*
   * `blockTextElements` 에 **pre 를 넣지 않는다.**
   *
   * 넣으면 파서가 `<pre>` 안을 "파싱하지 않은 원시 텍스트"로 취급한다. 공백을 지키려던
   * 설정인데 **마크업까지 같이 지켜서**, 청크 본문에 `<code class="prompt">$</code>` 같은
   * 태그가 그대로 들어간다. 실측: 5,028개 중 **384개(7.6%)** 가 오염됐다.
   *
   * 대가는 임베딩 낭비만이 아니다 — 인용을 펼치면 사용자에게 HTML 태그가 보인다.
   * "citations you can check" 라고 팔면서 보여주는 게 태그면 그 문장이 거짓이 된다.
   *
   * 빼도 공백은 지켜진다. 파서가 `<pre>` 를 정상 요소로 읽고 `.text` 가 자식 텍스트 노드를
   * 그대로 이어붙이므로 줄바꿈·들여쓰기는 남는다 (실측 확인).
   */
  const root = parse(html, { blockTextElements: { script: false, style: false } });

  for (const sel of DROP_SELECTORS) {
    for (const el of root.querySelectorAll(sel)) el.remove();
  }

  const title = clean(root.querySelector("title")?.text ?? "") || "(제목 없음)";

  const blocks: Block[] = [];
  const headingPath: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    // 각 항목은 이미 clean 을 거쳤다(PRE 제외). 여기서 다시 clean 하면 문단 구분까지 없어진다.
    const text = buffer.join("\n\n").trim();
    buffer = [];
    // H1 없이 H2 로 시작하는 문서가 흔하다(DocBook 이 그렇다). 그러면 headingPath[0] 이 비고
    // sparse 배열이 된다 — 그대로 내보내면 타입은 string[] 인데 실제로는 구멍이 있다.
    if (text.length > 0) blocks.push({ headingPath: compactPath(headingPath), text });
  };

  const visit = (el: HTMLElement): void => {
    for (const child of el.childNodes) {
      if (!(child instanceof Object) || !("tagName" in child)) continue;
      const node = child as HTMLElement;
      const tag = node.tagName?.toUpperCase();
      if (!tag) continue;

      if (HEADING_TAGS.has(tag)) {
        flush();
        const level = Number(tag[1]) - 1; // H1 → depth 0
        headingPath.length = Math.min(headingPath.length, level);
        headingPath[level] = clean(node.text);
        continue;
      }

      /*
       * 설정 파라미터·명령 옵션은 <dl><dt>이름</dt><dd>설명</dd>…</dl> 구조로 나온다.
       * <dl> 을 통째로 텍스트로 삼키면 work_mem / maintenance_work_mem / temp_buffers 의 설명이
       * 한 덩어리가 되어 토큰 예산에 따라 임의로 잘린다 — 그러면 "The default value is 2MB" 가
       * 어느 파라미터 것인지 청크만 봐서는 알 수 없고, 검색도 인용도 무의미해진다.
       *
       * 그래서 <dt> 를 **헤딩처럼** 취급한다. 이 코퍼스에서 가장 중요한 경계다.
       */
      if (tag === "DL") {
        flush();
        const depth = headingPath.length;
        for (const item of node.childNodes) {
          if (!("tagName" in item)) continue;
          const entry = item as HTMLElement;
          const t = entry.tagName?.toUpperCase();
          if (t === "DT") {
            flush();
            headingPath.length = depth;
            headingPath[depth] = clean(entry.text);
          } else if (t === "DD") {
            visit(entry);
            flush();
          }
        }
        headingPath.length = depth;
        continue;
      }

      if (TEXT_TAGS.has(tag)) {
        // PRE 는 공백이 의미를 가지므로 rawText 를 쓴다 (SQL 예제가 뭉개지면 안 된다).
        buffer.push(tag === "PRE" ? node.text.replace(/ /g, " ").trimEnd() : clean(node.text));
        continue;
      }

      visit(node);
    }
  };

  visit(root.querySelector("body") ?? root);
  flush();

  return { title, format: "html", blocks };
}
