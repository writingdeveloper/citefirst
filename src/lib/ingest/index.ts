import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { db, toVectorLiteral } from "../db/client.ts";
import { embedDocuments } from "../embed/index.ts";
import { chunkDoc, type Chunk } from "./chunk.ts";
import { parseDocx } from "./docx.ts";
import { parseHtml } from "./html.ts";
import { parsePdf } from "./pdf.ts";
import { parseMarkdown, parseText } from "./text.ts";
import type { DocFormat, ParsedDoc } from "./types.ts";

export function formatOf(filePath: string): DocFormat | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
    case ".htm":
      return "html";
    case ".pdf":
      return "pdf";
    case ".md":
    case ".markdown":
      return "md";
    case ".docx":
      return "docx";
    case ".txt":
    case "":
      return "txt"; // COPYRIGHT, README 처럼 확장자 없는 파일
    default:
      return null;
  }
}

export async function parseFile(filePath: string, format: DocFormat): Promise<ParsedDoc> {
  const title = path.basename(filePath);
  switch (format) {
    case "html":
      return parseHtml(await readFile(filePath, "utf8"));
    case "md":
      return parseMarkdown(await readFile(filePath, "utf8"), title);
    case "txt":
      return parseText(await readFile(filePath, "utf8"), title);
    case "docx":
      return parseDocx(await readFile(filePath), title);
    case "pdf":
      return parsePdf(new Uint8Array(await readFile(filePath)), title);
  }
}

export interface IngestResult {
  readonly sourcePath: string;
  readonly docId: number;
  readonly chunks: number;
  readonly skipped: boolean;
}

/**
 * 문서 하나를 ingest 한다.
 *
 * 재수집(Tier 2 약속): content_hash 가 같으면 통째로 건너뛰고, 다르면 **그 문서의 청크만**
 * 지우고 다시 넣는다. 전체 재구축이 아니라는 게 요점이다 — 실제 클라이언트 환경에서
 * 문서 하나 고쳤다고 전부 다시 임베딩하면 비용이 감당이 안 된다.
 */
export async function ingestFile(
  filePath: string,
  corpusRoot: string,
  opts: { sourceUrl?: string; force?: boolean } = {},
): Promise<IngestResult> {
  const pool = db();
  const format = formatOf(filePath);
  if (!format) throw new Error(`지원하지 않는 포맷: ${filePath}`);

  const raw = await readFile(filePath);
  const contentHash = createHash("sha256").update(raw).digest("hex");
  const sourcePath = path.relative(corpusRoot, filePath).replaceAll("\\", "/");

  const existing = await pool.query<{ id: string; content_hash: string }>(
    "SELECT id, content_hash FROM documents WHERE source_path = $1",
    [sourcePath],
  );
  const prev = existing.rows[0];
  if (prev && prev.content_hash === contentHash && !opts.force) {
    return { sourcePath, docId: Number(prev.id), chunks: 0, skipped: true };
  }

  const parsed = await parseFile(filePath, format);
  const chunks = chunkDoc(parsed, {
    maxTokens: config.chunkTokens,
    overlapTokens: config.chunkOverlap,
  });
  if (chunks.length === 0) {
    return { sourcePath, docId: prev ? Number(prev.id) : -1, chunks: 0, skipped: true };
  }

  const vectors = await embedDocuments(chunks.map((c) => c.embedText));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const docRes = await client.query<{ id: string }>(
      `INSERT INTO documents (source_path, title, format, content_hash, source_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_path) DO UPDATE
         SET title = EXCLUDED.title,
             format = EXCLUDED.format,
             content_hash = EXCLUDED.content_hash,
             source_url = EXCLUDED.source_url,
             ingested_at = now()
       RETURNING id`,
      [sourcePath, parsed.title, format, contentHash, opts.sourceUrl ?? null],
    );
    const docId = Number(docRes.rows[0]!.id);

    // 이 문서의 청크만 교체한다.
    await client.query("DELETE FROM chunks WHERE doc_id = $1", [docId]);

    for (const [i, chunk] of chunks.entries()) {
      await client.query(
        `INSERT INTO chunks (doc_id, position, content, token_count, heading_path, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [
          docId,
          chunk.position,
          chunk.content,
          chunk.tokenCount,
          chunk.headingPath.length > 0 ? chunk.headingPath.join(" > ") : null,
          toVectorLiteral(vectors[i]!),
        ],
      );
    }

    await client.query("COMMIT");
    return { sourcePath, docId, chunks: chunks.length, skipped: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export { chunkDoc, type Chunk };
