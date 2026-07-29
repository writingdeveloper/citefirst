import { streamAnswer } from "@/lib/answer/index.ts";

export const runtime = "nodejs";
/** pg 커넥션을 쓰므로 정적 최적화 대상이 되면 안 된다. */
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let question: string;
  let rerankEnabled: boolean | undefined;
  let rewriteEnabled: boolean | undefined;
  try {
    const body = (await req.json()) as {
      question?: unknown;
      rerankEnabled?: unknown;
      rewriteEnabled?: unknown;
    };
    if (typeof body.question !== "string" || body.question.trim() === "") {
      return Response.json({ error: "question 이 필요합니다." }, { status: 400 });
    }
    question = body.question.trim();
    // boolean 이 아니면 undefined 로 둔다 — config 기본값을 따르게 하기 위해서다.
    rerankEnabled = typeof body.rerankEnabled === "boolean" ? body.rerankEnabled : undefined;
    rewriteEnabled = typeof body.rewriteEnabled === "boolean" ? body.rewriteEnabled : undefined;
  } catch {
    return Response.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        for await (const event of streamAnswer(question, { rerankEnabled, rewriteEnabled })) {
          send(event);
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
