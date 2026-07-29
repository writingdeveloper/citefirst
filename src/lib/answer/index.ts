import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { retrieve, type RetrievedChunk, type RetrieveOptions, type RetrieveTrace } from "../retrieve/index.ts";
import { verifyCitations, type CitationCheck } from "./citations.ts";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.ts";

let client: Anthropic | undefined;

function anthropic(): Anthropic {
  // baseURL 을 주면 Anthropic 호환 프록시(CLIProxyAPI 등)로 나간다. 안 주면 api.anthropic.com.
  client ??= new Anthropic({
    apiKey: config.anthropicApiKey(),
    baseURL: config.anthropicBaseUrl(),
    /*
     * SDK 기본 재시도는 2회다. 로컬 프록시를 경유하면 그걸로 부족하다 — 46문항 × 2조건
     * 전체 평가가 중간에 5xx 하나로 통째로 죽었고, 그때까지 돈 40분이 날아갔다.
     * 재시도를 늘리는 건 수치를 좋게 만들지 않는다. **측정을 끝까지 가게 할 뿐이다.**
     */
    maxRetries: 5,
  });
  return client;
}

/**
 * thinking 이 기본 ON 이라 max_tokens 는 thinking + 응답을 합쳐서 제한한다.
 * RAG 답변 자체는 짧지만 여유를 두지 않으면 답변이 중간에 잘린다.
 */
const MAX_TOKENS = 8000;

/** system 은 배열로 넘긴다 — cache_control 을 붙이려면 블록 형태여야 한다. */
function systemBlocks(): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];
}

export interface AnswerResult {
  readonly question: string;
  readonly answer: CitationCheck;
  readonly retrieved: readonly RetrievedChunk[];
  readonly trace: RetrieveTrace;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
  };
  readonly ms: number;
}

export async function answerQuestion(question: string, opts: RetrieveOptions = {}): Promise<AnswerResult> {
  const t0 = performance.now();
  const { chunks, trace } = await retrieve(question, opts);

  const msg = await anthropic().messages.create({
    model: config.answerModel,
    max_tokens: MAX_TOKENS,
    system: systemBlocks(),
    output_config: { effort: config.answerEffort as "low" | "medium" | "high" },
    messages: [{ role: "user", content: buildUserMessage(question, chunks) }],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    question,
    answer: verifyCitations(text, chunks),
    retrieved: chunks,
    trace,
    usage: {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
    },
    ms: performance.now() - t0,
  };
}

/**
 * 스트리밍 답변 (UI 용).
 *
 * **인용 검증은 스트림이 끝난 뒤에만 할 수 있다** — 토큰이 `[c12` 까지만 도착한 시점에는
 * 그게 유효한 ID 인지 알 수 없기 때문이다. 그래서 UI 는 스트리밍 중에는 원문을 그대로 보여주고,
 * 완료 시점에 검증된 텍스트로 교체한다. onDone 이 그 시점이다.
 */
export async function* streamAnswer(
  question: string,
  opts: RetrieveOptions = {},
): AsyncGenerator<
  | { type: "retrieved"; chunks: readonly RetrievedChunk[]; trace: RetrieveTrace }
  | { type: "delta"; text: string }
  | { type: "done"; answer: CitationCheck },
  void
> {
  const { chunks, trace } = await retrieve(question, opts);
  yield { type: "retrieved", chunks, trace };

  const stream = anthropic().messages.stream({
    model: config.answerModel,
    max_tokens: MAX_TOKENS,
    system: systemBlocks(),
    output_config: { effort: config.answerEffort as "low" | "medium" | "high" },
    messages: [{ role: "user", content: buildUserMessage(question, chunks) }],
  });

  let full = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      full += event.delta.text;
      yield { type: "delta", text: event.delta.text };
    }
  }

  yield { type: "done", answer: verifyCitations(full, chunks) };
}

export { verifyCitations, type CitationCheck };
