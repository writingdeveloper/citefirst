"use client";

import { useState } from "react";

interface Citation {
  id: number;
  sourcePath: string;
  docTitle: string;
  headingPath: string | null;
  content: string;
}

interface RetrievedChunk {
  id: number;
  docTitle: string;
  headingPath: string | null;
  content: string;
  distance: number;
  rerankScore?: number;
}

/** 검색이 실제로 무엇을 했는지. 재작성을 켰다면 이걸 보여주지 않으면 사용자가 검증할 수 없다. */
interface Trace {
  queries: string[];
  rewriteEnabled: boolean;
  rewriteFailed: boolean;
  ms: { rewrite: number; embed: number; vector: number; keyword: number; rerank: number };
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [retrieved, setRetrieved] = useState<RetrievedChunk[]>([]);
  const [hallucinated, setHallucinated] = useState<string[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [rerankEnabled, setRerank] = useState(true);
  const [rewriteEnabled, setRewrite] = useState(true);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || streaming) return;

    setStreaming(true);
    setText("");
    setCitations([]);
    setRetrieved([]);
    setHallucinated([]);
    setOpen(null);
    setTrace(null);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, rerankEnabled, rewriteEnabled }),
      });
      if (!res.body) throw new Error("No stream in response");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          const event = JSON.parse(part.slice(6));
          if (event.type === "retrieved") {
            setRetrieved(event.chunks);
            setTrace(event.trace);
          }
          else if (event.type === "delta") setText((t) => t + event.text);
          else if (event.type === "done") {
            // 스트리밍 중에는 모델 원문을 보여줬다. 여기서 **검증된 텍스트로 교체**한다.
            // 검증 전 텍스트에는 아직 확인되지 않은 인용이 섞여 있을 수 있다.
            setText(event.answer.text);
            setCitations(event.answer.cited);
            setHallucinated(event.answer.hallucinated);
          } else if (event.type === "error") setError(event.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
    }
  }

  const byId = new Map(citations.map((c) => [c.id, c]));

  /** [c123] 을 클릭 가능한 각주로 바꾼다. 검증된 ID 만 링크가 된다. */
  const rendered = text.split(/(\[c\d+\])/g).map((part, i) => {
    const m = /^\[c(\d+)\]$/.exec(part);
    if (!m) return <span key={i}>{part}</span>;
    const id = Number(m[1]);
    const c = byId.get(id);
    if (!c) return <span key={i}>{part}</span>;
    const n = citations.findIndex((x) => x.id === id) + 1;
    return (
      <button key={i} className="cite" onClick={() => setOpen(open === id ? null : id)} title={c.headingPath ?? c.docTitle}>
        {n}
      </button>
    );
  });

  return (
    <main>
      <header>
        <h1>citefirst</h1>
        <p>Ask about the PostgreSQL 17 documentation. Answers use only the retrieved excerpts, and every citation is verified against them on the server.</p>
      </header>

      <form onSubmit={ask}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="My sorts keep spilling to disk — which setting caps that?"
          disabled={streaming}
        />
        <button type="submit" disabled={streaming || !question.trim()}>
          {streaming ? "…" : "Ask"}
        </button>
      </form>

      <label className="toggle">
        <input type="checkbox" checked={rerankEnabled} onChange={(e) => setRerank(e.target.checked)} disabled={streaming} />
        Reranking {rerankEnabled ? "" : "— off: showing raw vector-search order, so you can compare"}
      </label>

      <label className="toggle">
        <input type="checkbox" checked={rewriteEnabled} onChange={(e) => setRewrite(e.target.checked)} disabled={streaming} />
        Query rewriting {rewriteEnabled ? "" : "— off: searching your exact wording only"}
      </label>

      {error && <p className="error">{error}</p>}

      {/*
        재작성한 질의를 화면에 보여준다.
        "무엇으로 검색했는지"를 숨기면 사용자는 답이 어디서 왔는지 확인할 방법이 없다.
        인용을 서버에서 검증해 보여주는 것과 같은 이유다 — 검증 가능해야 신뢰가 생긴다.
      */}
      {trace?.rewriteEnabled && trace.queries.length > 1 && (
        <section className="rewrite">
          <p className="rewrite-label">
            Searched with {trace.queries.length} queries ({trace.ms.rewrite.toFixed(0)}ms to rewrite)
          </p>
          <ol>
            {trace.queries.map((q, i) => (
              <li key={q} className={i === 0 ? "original" : ""}>
                {i === 0 && <span className="tag">yours</span>}
                {q}
              </li>
            ))}
          </ol>
        </section>
      )}
      {trace?.rewriteEnabled && trace.rewriteFailed && (
        <p className="warn">Query rewriting failed for this question — searched your wording only.</p>
      )}

      {text && (
        <section className="answer">
          <div className="prose">{rendered}</div>

          {hallucinated.length > 0 && (
            <p className="warn">
              {hallucinated.length} citation(s) removed after verification ({hallucinated.join(", ")}) — they pointed at
              excerpts that were never retrieved.
            </p>
          )}

          {citations.length > 0 && (
            <ol className="sources">
              {citations.map((c) => (
                <li key={c.id} className={open === c.id ? "open" : ""}>
                  <button onClick={() => setOpen(open === c.id ? null : c.id)}>
                    {c.headingPath ?? c.docTitle}
                    <span className="path">{c.sourcePath}</span>
                  </button>
                  {open === c.id && <pre>{c.content}</pre>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {retrieved.length > 0 && (
        <details className="debug">
          <summary>Retrieved excerpts ({retrieved.length})</summary>
          <ol>
            {retrieved.map((c) => (
              <li key={c.id}>
                <code>c{c.id}</code> {c.headingPath ?? c.docTitle}
                <span className="score">
                  {/* 키워드 검색으로만 들어온 청크는 거리가 없다(NaN). "NaN" 을 찍는 대신 없다고 쓴다. */}
                  distance {Number.isFinite(c.distance) ? c.distance.toFixed(4) : "—"}
                  {c.rerankScore !== undefined && ` · rerank ${c.rerankScore.toFixed(4)}`}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </main>
  );
}
