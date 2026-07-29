import Anthropic from "@anthropic-ai/sdk";
import { config } from "../src/lib/config.ts";
import type { RetrievedChunk } from "../src/lib/retrieve/index.ts";
import { formatExcerpts } from "../src/lib/answer/prompt.ts";

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  // maxRetries 를 올리는 이유는 answer/index.ts 주석 참조 — 긴 측정이 5xx 하나로 죽지 않게 한다.
  client ??= new Anthropic({
    apiKey: config.anthropicApiKey(),
    baseURL: config.anthropicBaseUrl(),
    maxRetries: 5,
  });
  return client;
}

/**
 * judge 프롬프트.
 *
 * **이 코퍼스의 유일한 함정을 여기서 막는다** (AGENTS.md §6, decisions.md D9):
 * 모델은 PostgreSQL 을 이미 잘 안다. 그래서 "이 답이 맞나?"라고 물으면 judge 는
 * 검색 결과를 보지 않고 자기 사전지식으로 채점한다. 그러면 이 하네스는 검색 품질이 아니라
 * **모델이 Postgres 를 아는 정도**를 재게 된다 — 리랭킹을 꺼도 점수가 안 떨어진다.
 *
 * 그래서 두 축을 분리해서 묻는다:
 *   - grounded : 제시된 발췌**만으로** 이 답이 뒷받침되는가 (검색 품질)
 *   - correct  : 실행으로 확인한 정답과 일치하는가 (사실 정확도)
 *
 * grounded 가 검색을 재는 지표다. correct 만 보면 안 된다.
 */
const JUDGE_SYSTEM = `You grade answers produced by a retrieval-augmented system. You will be given: the question, the excerpts the system retrieved, the answer it produced, and a reference answer that was verified by running the actual software.

Grade two things independently. Do not let one influence the other.

## grounded

Is the answer supported by the excerpts ALONE?

You may know the subject matter well. That knowledge is irrelevant here and using it makes your grade worthless. Read only the excerpts. If the answer states something the excerpts do not contain, grounded is false — even when the statement is true, even when you are certain it is true. If the excerpts do not contain the answer and the system correctly said so, grounded is true: refusing without evidence is the right behaviour.

## correct

Does the answer match the reference answer?

Compare on substance, not wording. A different phrasing of the same value is correct. A different value, a different unit, a missing qualifier that changes the meaning, or a wrong version number is incorrect. If the system said it did not know, correct is false unless the reference answer also says the documentation does not specify it.

Be strict. When you are unsure, grade false and say why in one sentence.

## Output

Reply with a single JSON object and nothing else — no prose before or after, no code fence:

{"grounded": <true|false>, "correct": <true|false>, "reason": "<one sentence>"}

This instruction is not decoration. The response is parsed by a program; anything other than
that object is a failed run.`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    grounded: { type: "boolean", description: "Supported by the excerpts alone" },
    correct: { type: "boolean", description: "Matches the reference answer in substance" },
    reason: { type: "string", description: "One sentence. If either is false, say specifically what failed." },
  },
  required: ["grounded", "correct", "reason"],
  additionalProperties: false,
} as const;

export interface Verdict {
  readonly grounded: boolean;
  readonly correct: boolean;
  readonly reason: string;
}

export async function judge(args: {
  question: string;
  excerpts: readonly RetrievedChunk[];
  answer: string;
  referenceAnswer: string;
}): Promise<Verdict> {
  const userMessage = [
    `<question>\n${args.question}\n</question>`,
    `<excerpts>\n${args.excerpts.length > 0 ? formatExcerpts(args.excerpts) : "(none retrieved)"}\n</excerpts>`,
    `<answer>\n${args.answer}\n</answer>`,
    `<reference_answer>\n${args.referenceAnswer}\n</reference_answer>`,
  ].join("\n\n");

  const msg = await anthropic().messages.create({
    model: config.judgeModel,
    max_tokens: 4000,
    system: [{ type: "text", text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } }],
    // judge 는 답변 생성보다 판단이 어렵다. effort 를 한 단계 올린다.
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: JUDGE_SCHEMA },
    },
    messages: [{ role: "user", content: userMessage }],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return parseVerdict(text);
}

/**
 * judge 응답에서 판정을 뽑는다.
 *
 * **`output_config.format.json_schema` 를 믿지 않는다.** Anthropic 호환 프록시를 경유하면
 * 이 필드가 **조용히 무시되는 경우가 있다** — 에러도 나지 않고 그냥 자유 텍스트가 돌아온다
 * (CLIProxyAPI 7.2.104 에서 실측). 스키마가 적용되면 그대로 파싱되고, 무시되면 여기서 건진다.
 *
 * 조용히 실패하지 않는 것이 요점이다. 파싱이 안 되면 **던진다.** 기본값으로 넘어가면
 * "grounded=false" 가 채점 결과인지 파싱 실패인지 구분할 수 없게 되고, 그 수치는 쓸 수 없다.
 */
export function parseVerdict(text: string): Verdict {
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  // 앞뒤에 설명이 붙어도 첫 번째 JSON 객체를 건진다.
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;

  let parsed: Partial<Verdict>;
  try {
    parsed = JSON.parse(candidate) as Partial<Verdict>;
  } catch {
    throw new Error(
      `judge 응답을 JSON 으로 파싱하지 못했습니다. 구조화 출력이 적용되지 않은 것으로 보입니다.\n` +
        `받은 텍스트: ${text.slice(0, 300)}`,
    );
  }

  if (typeof parsed.grounded !== "boolean" || typeof parsed.correct !== "boolean") {
    throw new Error(`judge 응답에 grounded/correct 가 boolean 으로 없습니다: ${candidate.slice(0, 200)}`);
  }
  return { grounded: parsed.grounded, correct: parsed.correct, reason: String(parsed.reason ?? "") };
}
