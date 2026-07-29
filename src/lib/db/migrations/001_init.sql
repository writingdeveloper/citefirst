-- citefirst 초기 스키마
-- 인용 검증(D6)이 성립하려면 청크에 안정적인 ID가 있어야 한다. chunks.id 가 그 ID다.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id           BIGSERIAL PRIMARY KEY,
  source_path  TEXT        NOT NULL UNIQUE,   -- corpus/ 기준 상대 경로
  title        TEXT        NOT NULL,
  format       TEXT        NOT NULL,          -- html | pdf | md | txt | docx
  -- 재수집(Tier 2 약속) 경로에서 쓴다. 해시가 같으면 재임베딩을 건너뛴다.
  content_hash TEXT        NOT NULL,
  source_url   TEXT,
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id           BIGSERIAL PRIMARY KEY,
  doc_id       BIGINT      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position     INT         NOT NULL,          -- 문서 내 순서 (0부터)
  content      TEXT        NOT NULL,
  token_count  INT         NOT NULL,
  -- 청킹이 헤딩 경계를 인식했다는 증거이자, 인용을 사람이 읽을 수 있게 만드는 라벨.
  -- 예: "Server Configuration > Resource Consumption > Memory"
  heading_path TEXT,
  -- Xenova/bge-base-en-v1.5 (로컬, docs/decisions.md D11).
  -- 이 숫자는 config.embeddingDim 과 반드시 같아야 한다. 모델을 바꾸면 둘 다 고치고
  -- 새 마이그레이션으로 컬럼을 다시 만들어야 한다 — 차원이 다르면 pgvector 가 INSERT 를 거부한다.
  embedding    vector(768),
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (doc_id, position)
);

CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks (doc_id);

-- HNSW + 코사인. 임베딩이 비어있는 행이 있어도 인덱스는 만들어진다.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);
