import { approxTokens, type Block, type ParsedDoc } from "./types.ts";

export interface Chunk {
  readonly position: number;
  /** 원문 그대로. 인용으로 화면에 보여주는 것은 이 값이다. */
  readonly content: string;
  /**
   * 임베딩에 넣는 텍스트. 헤딩 경로를 앞에 붙인다.
   *
   * 이유: "Default: 4MB" 같은 문단은 그 자체로는 무엇의 기본값인지 알 수 없어서
   * 임베딩이 아무 데나 걸린다. 헤딩("Resource Consumption > Memory > work_mem")을
   * 붙이면 그 문단이 무엇에 관한 것인지가 벡터에 들어간다.
   * **content 와 분리하는 이유**는 인용을 보여줄 때 없던 텍스트가 섞이면 안 되기 때문이다.
   */
  readonly embedText: string;
  readonly headingPath: readonly string[];
  readonly tokenCount: number;
}

export interface ChunkOptions {
  readonly maxTokens: number;
  readonly overlapTokens: number;
}

/** 문장 경계로 자른다. 약어(e.g., i.e., vs.)에서 잘리지 않도록 뒤에 대문자/개행이 오는 경우만 경계로 본다. */
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?:])\s+(?=[A-Z(`])|\n{2,}/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * 청크 끝에서 오버랩으로 쓸 꼬리를 뽑는다.
 *
 * **예산을 넘는 문장은 통째로 담지 않는다.** 예전 구현은 "budget > 0 인 동안"으로 돌아서
 * 문장이 하나뿐이면 그 하나를 무조건 담았다 — 즉 **청크 전체**를 오버랩으로 돌려줬다.
 * 문장 경계가 없는 블록(코드 예제, `$` 프롬프트가 이어지는 pg_dump Examples 등)이 정확히
 * 그런 경우라, 다음 청크가 앞 청크를 통째로 포함하는 **중복 청크**가 만들어졌다.
 * 실제로 두 청크가 그렇게 나왔고, 검색 결과에서 같은 내용이 두 자리를 차지했다.
 *
 * 문장으로 못 자르면 낱말 경계에서 문자 단위로 끊는다. 오버랩은 문맥을 조금 잇는 장치이지
 * 원문을 보존하는 장치가 아니므로, 경계가 거칠어도 크기가 정해지는 편이 낫다.
 */
function overlapTail(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return "";
  const maxChars = overlapTokens * 4;

  const sentences = splitSentences(text);
  const tail: string[] = [];
  let chars = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i]!;
    if (chars + s.length > maxChars) break;
    tail.unshift(s);
    chars += s.length + 1;
  }
  if (tail.length > 0) return tail.join(" ");

  const cut = text.slice(-maxChars);
  const firstSpace = cut.indexOf(" ");
  return firstSpace > 0 ? cut.slice(firstSpace + 1) : cut;
}

/**
 * 블록을 청크로 묶는다.
 *
 * 규칙:
 *   1. **고정 토큰 슬라이싱을 하지 않는다.** 문단·헤딩 경계에서만 자른다 (AGENTS.md §5).
 *      문장이 잘리면 그 청크는 검색에도 인용에도 못 쓴다.
 *   2. 헤딩 경로가 바뀌면 무조건 새 청크. 서로 다른 파라미터 설명이 한 청크에 섞이면
 *      `work_mem` 질문에 `maintenance_work_mem` 청크가 걸리기 시작한다 — 이 코퍼스의 핵심 함정이다.
 *   3. 한 블록이 예산보다 크면 그때만 문장 경계로 분할한다.
 */
export function chunkDoc(doc: ParsedDoc, opts: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let bufferHeading: readonly string[] = [];
  let carry = "";
  /** carry 가 어느 헤딩에서 나왔는지. 경계를 넘어 붙는 걸 막는 데 쓴다. */
  let carryHeading: readonly string[] = [];

  const emit = () => {
    if (buffer.length === 0) return;
    const content = buffer.join("\n\n").trim();
    if (content.length === 0) {
      buffer = [];
      bufferTokens = 0;
      return;
    }
    const heading = bufferHeading.filter(Boolean);
    /*
     * **문서 제목을 임베딩 텍스트 앞에 넣는다.**
     *
     * SQL 명령 문서(DocBook refentry)는 헤딩이 "Description" / "Parameters" / "Notes" 뿐이고
     * 명령 이름은 문서 제목에만 있다. 그래서 이걸 안 넣으면 VACUUM 의 Notes 청크가
     * "Notes" 라는 문맥만 갖고 임베딩된다 — 벡터에 "VACUUM" 이라는 단어가 아예 없다.
     *
     * 실측: 이 상태에서 "routine table cleanup 을 BEGIN/COMMIT 으로 감쌀 수 있나" 질문의
     * 정답(VACUUM > Notes)이 top-10 밖으로 밀렸고, psql 의 --single-transaction 옵션이 1위였다.
     *
     * content 에는 넣지 않는다 — 인용을 펼쳤을 때 원문에 없던 텍스트가 보이면 안 된다.
     */
    const docTitle = doc.title && doc.title !== "(제목 없음)" ? [doc.title] : [];
    const path = [...docTitle, ...heading];
    const prefix = path.length > 0 ? `${path.join(" > ")}\n\n` : "";
    chunks.push({
      position: chunks.length,
      content,
      embedText: `${prefix}${content}`,
      headingPath: heading,
      tokenCount: approxTokens(content),
    });
    carry = overlapTail(content, opts.overlapTokens);
    carryHeading = heading;
    buffer = [];
    bufferTokens = 0;
  };

  const startBuffer = (heading: readonly string[]) => {
    bufferHeading = heading;
    /*
     * **오버랩은 같은 헤딩 안에서만 적용한다.**
     *
     * 안 그러면 직전 파라미터 설명의 꼬리가 다음 파라미터 청크의 앞에 붙는다. 실측에서
     * `maintenance_work_mem` 헤딩을 단 청크가 `hash_mem_multiplier` 내용으로 시작했다 —
     * 임베딩에는 두 파라미터가 섞여 들어가고, 인용을 펼치면 헤딩과 다른 내용이 나온다.
     * 이 코퍼스에서 없애려던 혼동을 오버랩이 되레 만들어내는 셈이라, 경계에서는 버린다.
     */
    if (carry && heading.length === carryHeading.length && heading.every((v, i) => v === carryHeading[i])) {
      buffer.push(carry);
      bufferTokens = approxTokens(carry);
    }
    carry = "";
  };

  const sameHeading = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  for (const block of doc.blocks) {
    if (buffer.length === 0) startBuffer(block.headingPath);
    else if (!sameHeading(block.headingPath, bufferHeading)) {
      emit();
      startBuffer(block.headingPath);
    }

    const blockTokens = approxTokens(block.text);

    if (blockTokens > opts.maxTokens) {
      emit();
      startBuffer(block.headingPath);
      for (const piece of packSentences(block, opts)) {
        buffer.push(piece);
        emit();
        startBuffer(block.headingPath);
      }
      continue;
    }

    if (bufferTokens + blockTokens > opts.maxTokens) {
      emit();
      startBuffer(block.headingPath);
    }

    buffer.push(block.text);
    bufferTokens += blockTokens;
  }
  emit();

  return chunks;
}

/**
 * 예산을 넘는 단일 블록을 문장 경계로 나눠 담는다.
 *
 * 문장별 토큰을 더해서 예산을 재면 **join 으로 끼어드는 구분자를 놓쳐** 실제 청크가
 * 예산을 넘는다 (짧은 문장이 많을수록 심해진다 — 측정해보니 25% 초과했다).
 * 그래서 합쳐진 결과의 문자 길이로 잰다.
 */
function packSentences(block: Block, opts: ChunkOptions): string[] {
  // 이 조각들 앞에는 직전 청크의 오버랩(carry)이 붙는다. 그 자리를 미리 빼두지 않으면
  // 완성된 청크가 예산을 오버랩만큼 넘긴다 (실측: 512 예산에 620 토큰까지 나왔다).
  const budget = Math.max(64, opts.maxTokens - opts.overlapTokens);
  const maxChars = budget * 4;
  const out: string[] = [];
  let cur: string[] = [];
  let chars = 0;

  const flushCur = () => {
    if (cur.length === 0) return;
    out.push(cur.join(" "));
    cur = [];
    chars = 0;
  };

  for (const s of splitSentences(block.text)) {
    /*
     * **한 "문장"이 예산보다 클 수 있다.** 문장 경계가 아예 없는 블록이 그렇다 —
     * SQL 키워드 표, pg_stat_* 컬럼 목록, 코드 예제 페이지가 전부 여기 해당한다.
     *
     * 예전 구현은 이런 조각을 자르지 못하고 그대로 내보냈다. 실측 결과 **137개 청크가
     * 512 토큰을 넘었고 최대 8,060 토큰**이었다. bge-base 의 입력 상한이 512 이므로
     * 그 뒤는 임베딩 단계에서 조용히 잘린다 — 즉 **벡터 검색으로 영원히 도달할 수 없는
     * 본문**이 코퍼스 안에 있었다는 뜻이다. 에러도 경고도 없이.
     *
     * 문장으로 못 자르면 낱말 경계로 자른다. 경계가 거친 청크가, 검색되지 않는 청크보다 낫다.
     */
    if (s.length > maxChars) {
      flushCur();
      out.push(...hardSplit(s, maxChars));
      continue;
    }

    const added = s.length + (cur.length > 0 ? 1 : 0); // 구분자 공백 1자 포함
    if (chars + added > maxChars && cur.length > 0) {
      flushCur();
      cur.push(s);
      chars = s.length;
      continue;
    }
    cur.push(s);
    chars += added;
  }
  flushCur();
  return out;
}

/** 문장 경계가 없는 조각을 낱말 경계에서 강제로 자른다. */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    // 공백이 하나도 없는 극단(한 낱말이 예산보다 김)이면 문자 수로 끊는다. 무한 루프를 막는 조건이기도 하다.
    if (cut <= 0) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}
