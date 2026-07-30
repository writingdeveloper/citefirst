# Decisions — English extract

The full decision log is [`decisions.md`](decisions.md), in Korean. This file translates
the three entries that matter most to a reader evaluating whether the numbers in
[`portfolio.md`](portfolio.md) can be trusted:

- [**D13** — Hybrid search is implemented and ships switched off, because the measurement said so](#d13)
- [**D14** — The corpus had three silent defects, and the metrics said nothing](#d14)
- [**D15** — Query rewriting was the only technique that crossed the vocabulary gap, and the reranker has to be given the same bridge](#d15)

They are the three where the result contradicted the expectation. Two of them are
failures. That is why these are the ones translated: a decision log where everything
worked is a brochure, not evidence.

Numbers here are copied from committed runs in [`eval/results/`](../eval/results).
Nothing in this file is an estimate.

---

<a id="d13"></a>

## D13. Hybrid search is implemented and ships switched off — the measurement said so

**What I did.** Added Postgres full-text search (`tsvector` + GIN) and fused it with
vector search using Reciprocal Rank Fusion. No re-embedding was needed — `tsvector` is
computed from the `content` column that was already stored.

**What I expected.** The five remaining retrieval failures were all vocabulary gaps
("routine table cleanup" ↔ `VACUUM`), so keyword search should close them.

**Result: wrong.**

> The table below is from **26 questions, before query rewriting existed.** Re-running the
> same comparison at 46 questions with rewriting on weakens the conclusion — see the
> follow-up after D15, and `portfolio.md`. The numbers are not edited to match, because
> what this decision was actually based on *is* the record.

| Metric (reranking ON, symptom-phrased, **26 questions · pre-rewriting**) | Hybrid OFF | Hybrid ON |
|---|---|---|
| recall@5 | 0.808 | 0.808 |
| MRR@10 | **0.556** | 0.551 |
| recall@5 (confusable questions only) | **0.895** | 0.842 |

**Why it was wrong.** If the question never contains the word `VACUUM`, **keyword search
cannot find that document either.** BM25-family scoring does not bridge a vocabulary gap;
it depends on lexical overlap more heavily than embeddings do. What it does instead is
promote the wrong documents, which then displace good vector candidates during fusion.
The −0.053 on confusable questions is that displacement actually happening.

**When it does help.** On a question set where users type the exact identifier, MRR@10
went 0.804 → **0.821** (same 26-question run). If that is how a client's users actually
search, it is worth turning on. **The identifier-phrased hybrid comparison was never
re-run at 46 questions** — that sentence rests on 26-question evidence only.

### It is the mirror image of reranking — this is the point

| | Symptom-phrased questions | Exact-identifier questions |
|---|---|---|
| **Reranking** | recall +0.116 ✅ | MRR −0.035 ❌ |
| **Hybrid search** | confusable recall −0.053 ❌ | MRR +0.017 ✅ |

Both techniques are commonly described as free improvements. **They pay off in opposite
situations.** Which one applies depends on how your users phrase questions, and that is
only knowable by measuring.

**Decision.** Keep the code, default `HYBRID_ENABLED=false`. The switch is itself a
deliverable — on a client corpus you re-measure and decide.

**This failure stays in the write-up.** Had I enabled hybrid search without measuring, it
would have made retrieval worse and I would not have known. Demonstrating exactly that is
the point of this repository.

---

<a id="d14"></a>

## D14. The corpus had three silent defects, and the metrics said nothing (2026-07-29)

**How I found them.** I was expanding the evaluation set from 26 questions to 46 and
writing new ground-truth labels. While eyeballing candidate chunks I noticed that the
body of a `pg_dump` chunk looked like this:

```
To dump a database called mydb into an SQL-script file: <code class="prompt">$</code>
<strong class="userinput"><code>pg_dump mydb > db.sql</code></strong> …
```

**The evaluation harness did not catch this.** At that moment the metrics read recall@5
1.000 and citation validity 1.000. A defect outside the paths your labels touch does not
appear in your metrics — that is a limit of this harness, and it is why reading chunk
output cannot be replaced by running the suite.

Digging in produced three separate defects.

### ① Markup inside `<pre>` leaked into the body text — 384 of 5,028 chunks (7.6%)

`node-html-parser`'s `blockTextElements: { pre: true }` treats the inside of `<pre>` as
**unparsed raw text**. I had set it to preserve indentation in SQL examples. It preserved
not just the whitespace but the markup.

The cost is not only wasted embedding budget. Expanding a citation showed HTML tags to the
user. If you claim citations a reader can check and what you show them is markup, the claim
is false.

Removing the setting still preserves whitespace, because the parser reads `<pre>` as a
normal element and `.text` concatenates its child text nodes verbatim. I verified that by
comparing output before and after rather than assuming it.

### ② Overlap copied the entire previous chunk

`overlapTail()` was a loop that "adds sentences from the end while budget remains." If a
chunk contains **exactly one sentence**, it adds that one unconditionally — which returns
**the whole chunk** as the overlap.

Blocks with no sentence boundaries are precisely that case: code-example pages, the
`pg_dump` Examples section with its run of `$` prompts. The result was that the next chunk
fully contained the previous one, and the same content occupied two slots in the retrieved
set.

### ③ 137 chunks exceeded the embedding input limit — up to 8,060 tokens (the worst one)

`packSentences()` splits an over-budget block **only at sentence boundaries**. When there
are none, it cannot split, and it emitted the block whole. SQL keyword tables,
`pg_stat_*` column lists, and example pages all land here.

`bge-base-en-v1.5` accepts 512 tokens. **Everything past that is silently truncated at the
embedding step.** No error, no warning. So the corpus contained body text that vector
search could never reach. Among the 137 was `monitoring-stats.html` — the answer document
for q025 and q026.

This is the worst of the three because **the failure does not look like a failure.** A
truncated chunk stores normally and retrieves normally. It simply has a tail that is not
in the vector.

### After the fix

| | Before | After |
|---|---|---|
| Chunks containing HTML tags | 384 | **0** |
| Chunks over 512 tokens (truncated at embedding) | 137 | **1** |
| Largest chunk | 8,060 tokens | 513 tokens |
| Mean chunk size | 130 tokens | 113 tokens |
| Total chunks | 5,028 | 5,012 |

Fragments that cannot be split at a sentence are now **split at a word boundary**
(`hardSplit`). A chunk with a rough boundary beats a chunk that cannot be retrieved.

All three defects have regression tests in `scripts/smoke-test.ts`. ③ only surfaced
*after* the test was written — with ② fixed, the "budget is respected" assertion caught a
1,123-token chunk.

**Lesson.** Good metrics and a clean corpus are two different claims. The 46 questions
cover roughly 20 of 309 documents. The metrics say nothing about what happens in the
other 289.

---

<a id="d15"></a>

## D15. Query rewriting — the only technique that crossed the vocabulary gap, and the reranker has to be given the same bridge (2026-07-29)

**The problem.** D13 made the reason for hybrid search's failure clear: when a user asks
about "routine table cleanup," **both vector search and keyword search** are anchored to
the words in that sentence. The word the document uses is `maintenance_work_mem`. Adding
another retriever does not cross that gap. **The vocabulary of the question itself has to
change.**

**What I did.** Send the question to an LLM and get back two or three search queries
phrased the way the documentation phrases things. Search with each query — the original is
always kept — and fuse the rankings with RRF.

```
"Does routine table cleanup get the same memory budget as an ordinary query?"
  → maintenance_work_mem memory for VACUUM and maintenance operations default setting
  → work_mem versus maintenance_work_mem resource consumption
  → autovacuum_work_mem memory budget for autovacuum workers default setting
```

### Results (46 symptom-phrased questions, retrieval metrics only)

| Configuration | recall@5 OFF → ON | MRR@10 OFF → ON | confusable recall (ON) |
|---|---|---|---|
| A. Baseline | 0.652 → 0.826 | 0.467 → 0.544 | 0.868 |
| B. Rewriting · reranker scores the **original** wording | 0.957 → **0.913** | 0.778 → **0.619** | 0.974 |
| C. Rewriting · reranker scores the **expanded** query | 0.957 → **0.978** | 0.778 → **0.834** | **1.000** |
| D. C + hybrid search | 0.935 → 0.978 | 0.759 → 0.849 | 1.000 |

**Rewriting alone took recall@5 from 0.826 to 0.978 and MRR from 0.544 to 0.834** — a
larger effect than any other change tried on this corpus.

### Row B is the real finding here — reranking gives the gain back

B and C saw **exactly the same retrieved candidates.** The rewrites were frozen to a file
before the runs, which is why the reranking-OFF column reads 0.957 in both. The only
difference is **what the reranker is asked to score against.**

Give it the original wording and recall@5 falls 0.957 → **0.913.** Three questions had the
right passage among the candidates and were pushed out of the top 5 anyway.

**Why.** The cross-encoder (`bge-reranker-base`) is a small model with no domain knowledge
connecting "routine table cleanup" to `maintenance_work_mem`. It cannot cross the gap the
rewriting model just crossed. So it demotes the chunk rewriting had found, on the grounds
that it does not resemble the question.

Give it the expanded query (original plus rewrites) and it goes 0.957 → **0.978.**
Reranking still earns its place — **but only once it is allowed over the same bridge.**

> Measuring techniques one at a time hides this. On a plain "rewriting ON/OFF" table both
> B and C look like improvements. **Where the interaction between two techniques loses
> value only shows up when you open it.**

### Hybrid search is no longer harmful (a postscript to D13)

In D13, hybrid search dropped confusable recall from 0.895 to 0.842. The cause was the
vocabulary gap: with no identifier in the question, keyword search promoted the wrong
documents and displaced good vector candidates.

Rewriting removes that cause. The rewrites contain the identifiers, so keyword search finds
the right document too. In configuration D, confusable recall is 0.974 with reranking off —
higher than C's 0.947 — and MRR goes 0.834 → 0.849.

**The default stays OFF anyway.** recall@5 is identical at 0.978, and +0.012 MRR is what one
question moving one rank does in a 46-question sample. That does not justify an extra
full-text query per rewritten query. **A cause being removed is not by itself a reason to
turn something on.**

### What it costs

| | |
|---|---|
| Latency | rewriting call averages **4,066 ms** per query (max 12,648 ms) |
| Tokens | roughly 630 in, 50 out per question |
| Failures | 0 of 46 (on a parse failure it searches with the original query only and reports `rewriteFailed`) |

The latency is significant. An interactive UI has to stream, showing the rewrites and the
retrieval as they happen, and any workload with repeated questions effectively requires a
cache.

### The honest caveat — do not carry these numbers straight to a client

**The rewriting model already knows PostgreSQL.** Mapping "sorts spilling to disk" to
`work_mem` is the model's prior knowledge, not retrieval. So part of the +0.195 is not
"retrieval got better" but "a domain expert was added in front of the retriever."

That is practically valid, because the same model is available in production. But over a
corpus **no model has seen** — internal documents, a company's own vocabulary — expect
less. There, the rewriter needs a glossary in its prompt (client abbreviations, product
name mappings) to do the same job. This caveat is recorded in
[`portfolio.md`](portfolio.md) and `.env.example` as well as here.

### Reproducibility — rewriting is not deterministic

Two runs of the identical configuration produced recall@5 of 0.962 and 1.000 (at the
26-question stage). Nothing in the configuration changed. The only difference was which
rewrites the model produced that day.

In that state, part of "expanded beats original" is noise. So the rewrites are frozen to
`eval/rewrite-cache.json` and **that file is committed.** The latency and token counts from
the original calls are stored with them, so the cost figures above remain measured values
rather than re-estimates.

**Decision.** `REWRITE_ENABLED=true` and `RERANK_QUERY=expanded` are the defaults.
`HYBRID_ENABLED` stays `false`.
