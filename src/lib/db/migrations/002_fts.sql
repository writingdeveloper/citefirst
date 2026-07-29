-- 하이브리드 검색: 벡터 검색에 키워드(BM25 계열) 검색을 더한다.
--
-- 왜 필요한가 — 측정으로 나온 이유다. 남은 실패 5건이 전부 **어휘 격차**였다:
-- 사용자가 "routine table cleanup" 이라 물으면 임베딩은 VACUUM 문서를 못 집는다.
-- 두 어휘가 벡터 공간에서 충분히 가깝지 않기 때문이고, 이건 임베딩 모델을 키워도
-- 완전히는 안 없어진다. 반면 키워드 검색은 "VACUUM" 같은 **정확한 식별자**에 강하다.
-- 서로 다른 실패 모드를 가진 두 검색을 합치는 게 요점이다.
--
-- 임베딩은 다시 만들지 않는다. tsvector 는 이미 저장된 content 로 계산할 수 있다.

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS fts tsvector;

-- 헤딩 경로에 가중치를 준다.
-- 설정 파라미터 문서에서 이름은 <dt>(→ heading_path)에만 있고 본문에는 없다.
-- 'A' 가중치를 주면 "work_mem" 을 그대로 친 질의가 그 청크를 정확히 집는다.
UPDATE chunks
   SET fts = setweight(to_tsvector('english', coalesce(heading_path, '')), 'A')
          || setweight(to_tsvector('english', content), 'B')
 WHERE fts IS NULL;

-- 이후 INSERT/UPDATE 에서 자동으로 채워지게 한다.
-- 생성 열(GENERATED)을 쓰지 않는 이유: 이 테이블은 이미 데이터가 있고,
-- 생성 열은 나중에 붙일 때 테이블 전체 재작성을 요구한다.
CREATE OR REPLACE FUNCTION chunks_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts := setweight(to_tsvector('english', coalesce(NEW.heading_path, '')), 'A')
          || setweight(to_tsvector('english', NEW.content), 'B');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_fts_update ON chunks;
CREATE TRIGGER chunks_fts_update
  BEFORE INSERT OR UPDATE OF content, heading_path ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_fts_trigger();

CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (fts);
