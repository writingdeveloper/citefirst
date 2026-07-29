/**
 * 파서·청커·인용검증 스모크 테스트.
 *
 * DB 도 API 키도 없이 도는 부분만 확인한다. 파이프라인에서 **외부 의존이 없는 로직**이
 * 여기 다 모여 있고, 검색 품질이 나빠졌을 때 원인이 이쪽인지 아닌지를 가르는 첫 관문이다.
 *
 *   npx tsx scripts/smoke-test.ts
 */
import { parseHtml } from "../src/lib/ingest/html.ts";
import { parseMarkdown, parseText } from "../src/lib/ingest/text.ts";
import { chunkDoc } from "../src/lib/ingest/chunk.ts";
import { verifyCitations } from "../src/lib/answer/citations.ts";
import type { RetrievedChunk } from "../src/lib/retrieve/index.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
}

/** DocBook 이 실제로 뱉는 구조를 축소해서 재현한 것. */
const HTML = `<html><head><title>20.4. Resource Consumption</title></head><body>
<div class="navheader"><table><tr><td>Prev</td><td>Up</td><td>Next</td></tr></table></div>
<div class="sect1"><h2 class="title">20.4. Resource Consumption</h2>
<div class="sect2"><h3 class="title">20.4.1. Memory</h3>
<p><code>work_mem</code> (<code>integer</code>) Sets the base maximum amount of memory to be used by a query operation before writing to temporary disk files. The default value is four megabytes (<code>4MB</code>).</p>
<pre class="programlisting">SET work_mem = '64MB';</pre>
<p><code>maintenance_work_mem</code> (<code>integer</code>) Specifies the maximum amount of memory to be used by maintenance operations, such as <code>VACUUM</code>. The default value is 64 megabytes (<code>64MB</code>).</p>
</div></div>
<div class="navfooter"><table><tr><td>Prev</td><td>Home</td><td>Next</td></tr></table></div>
</body></html>`;

console.log("HTML 파서");
const doc = parseHtml(HTML);
check("제목 추출", doc.title === "20.4. Resource Consumption", doc.title);
const allText = doc.blocks.map((b) => b.text).join(" ");
// 네비게이션이 남으면 모든 청크에 "Prev/Up/Next" 가 섞여 임베딩이 오염된다.
check("navheader/navfooter 제거", !/\bPrev\b|\bHome\b/.test(allText), allText.slice(0, 60));
check("본문 보존", allText.includes("4MB") && allText.includes("64MB"));
check("PRE 내용 보존", allText.includes("SET work_mem = '64MB';"));
/*
 * `<pre>` 안의 마크업이 텍스트로 새면 안 된다.
 *
 * node-html-parser 의 blockTextElements 에 pre 를 넣으면 안쪽을 원시 텍스트로 취급해
 * 태그가 그대로 남는다. 실측으로 5,028 청크 중 384개가 그렇게 오염돼 있었고,
 * 인용을 펼치면 사용자에게 `<code class="prompt">` 가 보였다.
 */
check(
  "PRE 안의 마크업이 텍스트로 안 샘",
  !/<\/?(code|strong|em|span|a)\b/.test(allText),
  allText.match(/<\/?[a-z]+[^>]*>/)?.[0] ?? "",
);
check(
  "헤딩 경로 인식",
  doc.blocks.some((b) => b.headingPath.join(">").includes("Memory")),
  JSON.stringify(doc.blocks[0]?.headingPath),
);

console.log("\n청커");
const chunks = chunkDoc(doc, { maxTokens: 60, overlapTokens: 10 });
check("청크 생성", chunks.length > 0, `${chunks.length}개`);
// prefix 는 "문서제목 > 헤딩 > 헤딩" 형태다. 문서 제목이 앞에 오는 이유는 chunk.ts 주석 참조.
check(
  "embedText 가 문서 제목으로 시작",
  chunks.every((c) => c.embedText.startsWith(doc.title)),
  chunks[0]?.embedText.slice(0, 60),
);
check(
  "embedText prefix 에 헤딩 경로 포함",
  chunks.every((c) => c.headingPath.every((h) => c.embedText.slice(0, 200).includes(h))),
);
check("content 에는 헤딩이 안 섞임", chunks.every((c) => !c.content.includes("20.4. Resource Consumption >")));
check("position 연속", chunks.every((c, i) => c.position === i));
// sparse 배열이 통과하면 headingPath 는 타입만 string[] 이고 실제로는 구멍이 있다.
check(
  "headingPath 에 구멍 없음",
  chunks.every((c) => c.headingPath.every((s) => typeof s === "string" && s.length > 0)),
  JSON.stringify(chunks[0]?.headingPath),
);

const big = { title: "t", format: "txt" as const, blocks: [{ headingPath: [], text: "One. ".repeat(400) }] };
const split = chunkDoc(big, { maxTokens: 100, overlapTokens: 0 });
check("예산 초과 블록 분할", split.length > 1, `${split.length}개`);
check(
  "예산을 실제로 지킴 (≤100 토큰)",
  split.every((c) => c.tokenCount <= 100),
  JSON.stringify(split.map((c) => c.tokenCount)),
);

/*
 * **문장 경계가 없는 긴 블록.** 코드 예제 페이지(pg_dump 의 Examples 등)가 이렇다.
 *
 * 예전 overlapTail 은 "예산이 남는 동안"으로 돌아서 문장이 하나뿐이면 그 하나 —
 * 즉 청크 전체 — 를 오버랩으로 돌려줬다. 그 결과 다음 청크가 앞 청크를 통째로 포함했다.
 * 실제 코퍼스에서 그런 청크 쌍이 나왔고, 검색 결과에서 같은 내용이 두 자리를 먹었다.
 */
const noSentences = {
  title: "t",
  format: "txt" as const,
  blocks: [{ headingPath: ["Examples"], text: Array.from({ length: 200 }, (_, i) => `pg_dump -t tbl${i} mydb`).join(" ") }],
};
const nos = chunkDoc(noSentences, { maxTokens: 100, overlapTokens: 20 });
check("문장 경계 없는 블록도 분할", nos.length > 1, `${nos.length}개`);
check(
  "앞 청크를 통째로 포함하는 청크가 없음",
  nos.every((c, i) => i === 0 || !c.content.includes(nos[i - 1]!.content)),
  JSON.stringify(nos.map((c) => c.tokenCount)),
);
check("문장 경계 없어도 예산 유지 (≤100 토큰)", nos.every((c) => c.tokenCount <= 100));

/*
 * 설정 파라미터의 실제 구조. 이 케이스가 이 코퍼스에서 가장 중요하다 —
 * 여기가 깨지면 work_mem 질문에 maintenance_work_mem 청크가 걸리기 시작하고,
 * 리랭킹 before/after 표가 의미를 잃는다.
 */
const VARLIST = `<html><head><title>19.4. Resource Consumption</title></head><body>
<div class="sect2"><h3 class="title">19.4.1. Memory <a href="#MEM" class="id_link">#</a></h3>
<dl class="variablelist">
<dt id="GUC-WORK-MEM"><span class="term"><code>work_mem</code> (<code>integer</code>)</span> <a href="#GUC-WORK-MEM" class="id_link">#</a></dt>
<dd><p>Sets the base maximum amount of memory to be used by a query operation before writing to temporary disk files. The default value is four megabytes (<code>4MB</code>).</p></dd>
<dt id="GUC-MAINT"><span class="term"><code>maintenance_work_mem</code> (<code>integer</code>)</span> <a href="#GUC-MAINT" class="id_link">#</a></dt>
<dd><p>Specifies the maximum amount of memory to be used by maintenance operations, such as <code>VACUUM</code>. It defaults to 64 megabytes (<code>64MB</code>).</p></dd>
</dl></div></body></html>`;

console.log("\n설정 파라미터 구조 (dl/dt/dd)");
const vl = chunkDoc(parseHtml(VARLIST), { maxTokens: 512, overlapTokens: 64 });
const wm = vl.find((c) => c.headingPath.some((h) => h.startsWith("work_mem")));
const mwm = vl.find((c) => c.headingPath.some((h) => h.startsWith("maintenance_work_mem")));
check("파라미터마다 청크가 갈라짐", wm !== undefined && mwm !== undefined, `${vl.length}개`);
check("헤딩에서 앵커 # 제거", vl.every((c) => !c.headingPath.some((h) => h.includes("#"))), JSON.stringify(vl[0]?.headingPath));
// 아래 둘이 실제로 깨졌던 지점이다: 오버랩이 파라미터 경계를 넘어 내용을 끌고 왔었다.
check("work_mem 청크에 자기 기본값", wm?.content.includes("4MB") === true);
check("work_mem 청크에 남의 기본값이 안 섞임", wm?.content.includes("64MB") === false, wm?.content.slice(0, 80));
check("maintenance_work_mem 청크에 자기 기본값", mwm?.content.includes("64MB") === true);
check(
  "maintenance_work_mem 청크가 앞 파라미터 내용으로 시작하지 않음",
  mwm?.content.startsWith("Specifies") === true,
  mwm?.content.slice(0, 60),
);

console.log("\nMarkdown / plain text 파서");
const mdDoc = parseMarkdown("# Title\n\nintro text here\n\n## Sec A\n\n```\n# not a heading\n```\n\nbody of a\n", "f.md");
check("제목 = 첫 H1", mdDoc.title === "Title", mdDoc.title);
check("코드펜스 안의 # 은 헤딩이 아님", !mdDoc.blocks.some((b) => b.headingPath.includes("not a heading")));
check("H2 경로 인식", mdDoc.blocks.some((b) => b.headingPath.includes("Sec A")));
const txtDoc = parseText("para one\nline two\n\n\npara two\n", "README");
check("빈 줄로 문단 분리", txtDoc.blocks.length === 2, `${txtDoc.blocks.length}개`);

console.log("\n인용 검증 (D6)");
const provided: RetrievedChunk[] = [
  { id: 11, docId: 1, sourcePath: "a.html", docTitle: "A", headingPath: "H", content: "x", distance: 0.1 },
  { id: 12, docId: 1, sourcePath: "a.html", docTitle: "A", headingPath: "H", content: "y", distance: 0.2 },
];
const res = verifyCitations("The default is 4MB [c11]. Also see [c99]. And [c12].", provided);
check("유효 인용 유지", res.text.includes("[c11]") && res.text.includes("[c12]"));
check("환각 인용 제거", !res.text.includes("[c99]"), res.text);
check("환각 기록", res.hallucinated.length === 1 && res.hallucinated[0] === "[c99]", JSON.stringify(res.hallucinated));
check("인용 목록 중복 제거", res.cited.length === 2, `${res.cited.length}`);
const res2 = verifyCitations("No evidence for this.", provided);
check("인용 없는 답변 처리", res2.cited.length === 0 && res2.hallucinated.length === 0);

console.log(`\n${failed === 0 ? "전부 통과" : `실패 ${failed}건`}`);
process.exit(failed === 0 ? 0 : 1);
