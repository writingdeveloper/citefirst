# AGENTS.md — citefirst

> **이 레포에서 작업을 시작할 때 이 파일을 먼저 읽는다.**
>
> **구현은 끝났고 수치가 나와 있다** (2026-07-29). 파이프라인 전 구간이 동작하고
> 46개 질문으로 측정을 마쳤다 — 결과는 [`docs/portfolio.md`](docs/portfolio.md).
> 아래 §5는 이제 "만들 순서"가 아니라 **각 단계가 어떤 상태인지의 기록**이다.
> 다음에 할 일은 §8에 있다.

---

## 0. 이 프로젝트가 무엇인가 (읽지 않고 시작하지 말 것)

검색 품질에 대한 주장 하나하나에 **실측 수치가 붙어 있는** RAG 시스템이다.
"정확도 좋음"이 아니라 "recall@5 = 0.978"을 쓸 수 있는 것이 목표였고,
그래서 **eval 하네스가 UI보다 우선순위가 높았다.**

코퍼스는 PostgreSQL 17 매뉴얼 — 약 3,000쪽. 두 가지 이유로 골랐다.
정답을 모델에 묻지 않고 **소프트웨어를 실행해서** 검증할 수 있고,
거의 똑같이 생긴 문단이 널려 있어(`pg_dump` vs `pg_dumpall`, `*_work_mem` 다섯 종)
**검색이 조용히 틀리는** 코퍼스다.

측정 결과는 [`docs/portfolio.md`](docs/portfolio.md),
설계 판단의 근거는 [`docs/decisions.md`](docs/decisions.md)
(영문 발췌: [`docs/decisions-en.md`](docs/decisions-en.md) — D13·D14·D15).
측정이 나쁘게 나온 기법은 **끈 채로 남기고 이유를 적어 두었고**(D13 하이브리드 검색),
효과가 있었던 기법도 **그 이득의 어디까지가 진짜인지**를 같이 적었다(D15 쿼리 재작성).

구현 판단이 애매하면 기준은 `docs/decisions.md` 다. 거기에 없는 판단이면 새로 적는다.

---

## 1. 절대 규칙

- **거짓 수치 금지.** 포트폴리오에 들어갈 숫자는 전부 실제로 실행한 eval 결과여야 한다. 추정치·기대치를 결과처럼 쓰지 않는다. 못 돌렸으면 못 돌렸다고 쓴다.
- **API 키를 커밋하지 않는다.** `.env`는 gitignore 되어 있다. `.env.example`만 커밋한다. 명령줄에 키를 리터럴로 넣지 않는다.
- **커밋은 사용자가 요청할 때만.** 알아서 커밋하지 않는다. 기본 브랜치는 `main`.
- **문서에 스크린샷 원본을 넣지 않는다** — 개인정보가 찍힐 수 있는 캡처는 레포에 넣지 않는다. 데모 화면 캡처는 `assets/`에 넣되 커밋 전에 내용을 확인한다.
- 저작권 있는 문서를 코퍼스로 커밋하지 않는다 (§4 참조).

---

## 2. 스택 — 이미 정해졌다. 다시 고르지 말 것

근거는 [`docs/decisions.md`](docs/decisions.md)에 있다. 요약:

| 레이어 | 선택 | 이유 |
|---|---|---|
| 앱 | Next.js 16 (App Router) + TypeScript | 기존 레포들과 스택이 같아 유지보수가 갈라지지 않는다 |
| 벡터 저장소 | PostgreSQL 17 + **pgvector** | 이미 쓰는 DB 안에서 끝난다 — 별도 벡터 DB를 세우지 않는다 |
| 임베딩 | **로컬** `Xenova/bge-base-en-v1.5` (768차원) | 문서를 외부로 보내지 않는다 — D11 |
| 리랭킹 | **로컬** `Xenova/bge-reranker-base` (크로스 인코더) | 리랭킹이 **실제로 값을 하는지 재는 것**이 이 레포의 목적 중 하나다 — D9 |
| 쿼리 재작성 | 답변 모델과 같은 엔드포인트 (`REWRITE_ENABLED`) | 어휘 격차를 넘는 유일한 수단 — D15. **리랭커에도 확장 질의를 준다** (`RERANK_QUERY=expanded`) |
| 답변 생성 | **`gpt-5.6-sol`** (Codex 구독, 로컬 프록시 경유) | 프로토콜 경계로 잘라 provider 교체 가능 — D12 |
| 로컬 인프라 | Docker Compose 또는 WSL2 안의 Postgres 17 | 클라이언트가 재현 가능해야 함 |
| Eval | 자체 하네스 (아래 §6) | 숫자를 뽑는 게 핵심 |

**임베딩을 Anthropic API로 만들려고 시도하지 말 것.** Anthropic은 임베딩 엔드포인트를 제공하지 않는다. Anthropic 호환 프록시(CLIProxyAPI 등)에도 embeddings 엔드포인트는 없다.

**임베딩·리랭킹은 관리형 API로 되돌리지 말 것.** 이 스택의 핵심 성질이 "문서가 기계 밖으로 나가지 않는다"이고, 그게 계약서·내부 정책을 다루는 클라이언트에게는 결정적이다. 근거는 `docs/decisions.md` D11. 모델을 키우는 건(bge-large 등) 괜찮지만 **`EMBEDDING_DIM`과 마이그레이션의 `vector(...)`를 같이 고쳐야 한다.**

`ANTHROPIC_BASE_URL`로 Anthropic 호환 엔드포인트를 지정한다. SDK 코드는 어느 쪽이든 그대로다.

### 답변 계층 사양

**현재 구성:** `@anthropic-ai/sdk` → `ANTHROPIC_BASE_URL`(로컬 CLIProxyAPI) → Codex(`gpt-5.6-sol`).

⚠️ **프록시 경유 시 실측된 제약 (CLIProxyAPI 7.2.104):**
- `output_config.format.json_schema` 가 **에러 없이 무시된다.** 구조화 출력을 믿지 말 것 —
  judge 는 프롬프트로 JSON 을 지시하고 `parseVerdict()` 로 건진다. 이 패턴을 되돌리지 말 것.
- **프롬프트 캐싱이 걸리지 않는다** (`cache_read_input_tokens = 0`). 비용 계산에 캐시를 전제하지 않는다.
- `output_config.effort` 와 `cache_control` 은 400 을 내지 않고 통과한다(무해).

아래는 **Anthropic 직결로 바꿀 때** 지켜야 할 사양이다 (2026-07 기준):

- 모델 ID는 **`claude-opus-5`** 그대로 쓴다. 날짜 접미사를 붙이지 않는다.
- `temperature` / `top_p` / `top_k` 를 **보내면 400 에러**다. 제거한다. 출력 제어는 프롬프트로 한다.
- `thinking: {type: "enabled", budget_tokens: N}` 은 **제거됨(400)**. 필요하면 `thinking: {type: "adaptive"}`.
- `claude-opus-5`는 **thinking이 기본 ON**이다. `max_tokens`는 thinking + 응답 텍스트를 합쳐서 제한하므로 넉넉히 잡는다. 끄려면 `thinking: {type: "disabled"}` — 단 `effort`가 `xhigh`/`max`면 400.
- 사고 강도는 `output_config: {effort: "low"|"medium"|"high"|"xhigh"|"max"}`. RAG 답변 생성은 `low` 또는 `medium`으로 충분하다 — 검색된 근거를 읽고 인용해 답하는 작업이라 깊은 추론이 필요 없다. **비용/지연시간에 직접 영향을 주니 반드시 명시한다.**
- 마지막 턴 assistant prefill은 **400**이다. 출력 형식을 강제하려면 `output_config: {format: {type: "json_schema", schema: ...}}`를 쓴다.
- `max_tokens`가 크면 스트리밍한다. 채팅 UI이므로 어차피 스트리밍이 맞다.
- 프롬프트 캐싱: 시스템 프롬프트에 `cache_control: {type: "ephemeral"}`. `claude-opus-5`는 **512토큰**부터 캐시된다. 단 **캐시는 prefix 매칭**이므로 시스템 프롬프트에 타임스탬프/UUID를 넣으면 매번 무효화된다 — 절대 넣지 말 것.
- SDK: `@anthropic-ai/sdk`. 응답의 `content`는 union이므로 `block.type === "text"`로 좁힌 뒤 `.text`를 읽는다.

---

## 3. 아키텍처

```
문서 (PDF/DOCX/MD/TXT)
   ↓  ingest
파싱 → 청킹 → 임베딩(로컬 ONNX) → pgvector 저장
   ↓
질문
   ↓  retrieve
벡터 검색(top-k=20) → 리랭킹(로컬 크로스 인코더 → top-N)
   ↓  answer
답변 모델 + 검색된 청크 → 인용 달린 답변
   ↓
웹 UI (스트리밍) / API 엔드포인트
```

인용은 **환각이 불가능한 구조**로 만든다: 각 청크에 ID를 부여해 프롬프트에 넣고, 모델이 `[chunk_id]` 형태로 참조하게 한 뒤, **서버에서 실제 청크와 매칭해 렌더링한다.** 매칭 실패한 인용은 UI에 표시하지 않고 로그에 남긴다. 이 시스템의 존재 이유가 "확인할 수 있는 인용"이므로, 환각 인용을 그대로 화면에 띄우면 그 이유가 무너진다.

### 디렉터리

```
src/
  app/                  # Next.js App Router (chat UI + API routes)
    api/chat/route.ts   # 스트리밍 답변 엔드포인트
  lib/
    ingest/             # 파서, 청커
    embed/              # 로컬 임베딩·리랭킹 (ONNX)
    retrieve/           # pgvector 검색 + 리랭킹
    answer/             # 답변 프롬프트 + 인용 검증
    db/                 # 스키마, 마이그레이션
eval/
  questions.yaml        # 평가 질문 세트 (정답 청크 id 라벨 포함)
  run.ts                # 하네스
  results/              # 실행 결과 (커밋함 — 포트폴리오 근거)
corpus/                 # 코퍼스 (§4 — 라이선스 확인 필수)
docs/
scripts/
```

---

## 4. 코퍼스 = PostgreSQL 17 공식 문서 (확정)

이런 시스템이 실제로 투입되는 문서는 정책·**매뉴얼**·티켓·계약서다. PostgreSQL 문서는
그중 **매뉴얼**이고, 아래 네 조건을 동시에 만족하는 유일한 후보라 선택됐다. 근거 전문은
[`docs/decisions.md`](docs/decisions.md) D9.

### 왜 이걸 골랐나

**① 정답 라벨을 실행으로 검증할 수 있다 — 이게 결정적이다.**
`docker-compose.yml`에 이미 Postgres 17이 떠 있다. "`max_connections` 기본값은?" 같은 질문의 정답을
`SHOW max_connections;` 로 확인할 수 있다. eval의 최대 약점은 정답 라벨링이고, 도메인 지식이 필요한
코퍼스(법률·의료)를 고르면 라벨이 추측이 되어 **숫자 전체가 무의미해진다.** 여기서는 라벨링이 추측이
아니라 실행이다.

**② 검색이 실제로 어렵다 — 이것도 필수 조건이다.**
코퍼스가 쉬우면 리랭킹 on/off 양쪽 다 recall@5가 0.95쯤 나오고, **기법이 효과가 있었는지 없었는지를
애초에 구분할 수 없다.** PG 문서에는 함정이 많다:
`pg_dump`/`pg_dumpall`/`pg_restore`, `VACUUM`/`VACUUM FULL`/autovacuum, 이름이 비슷한 설정
파라미터(`work_mem`/`maintenance_work_mem`/`autovacuum_work_mem`), 버전별 동작 변경, deprecated 기능.
질문 세트를 짤 때 **이런 혼동 지점을 의도적으로 노린다.**

**③ 라이선스가 깨끗하다.** PostgreSQL License (BSD 계열) — 재배포 허용.

**④ 포맷 커버리지.** 같은 내용을 HTML 타르볼과 PDF로 배포한다. 소스 트리에는 plain text `README`류가
있다. 파서 3종(HTML/PDF/TXT)을 한 코퍼스로 태울 수 있다.

### 가져오는 방법

`scripts/fetch-corpus.ts` 로 로컬에 받는다. **문서 파일은 커밋하지 않는다** (`.gitignore` 참조).
출처·이용 조건은 [`corpus/SOURCES.md`](corpus/SOURCES.md) 표에 기록한다.

- HTML: postgresql.org 가 배포하는 문서 타르볼
- PDF: 동일 버전 PDF (A4 또는 US letter)

**라이선스는 1차 출처에서 직접 확인한다.** 배포물 안의 저작권 고지(`COPYRIGHT` 파일 등)를 열어 실제 문구를
읽고, 전문을 `corpus/SOURCES.md`에 옮긴다. 이 파일에 적힌 "BSD 계열이니 괜찮다"를 근거로 삼지 말 것 —
1차 출처를 확인하는 게 규칙이다.

### 범위 조절

전체 문서는 크다. 첫 실행은 아래로 좁혀 ingest 시간을 줄인다. 부족하면 넓힌다.
- Server Administration
- SQL Commands
- Client Applications / Server Applications
- Configuration (`Server Configuration` 전체)

혼동 지점이 여기 다 들어있어서 난이도는 유지된다.

### 절대 넣지 말 것

사용자의 개인 문서, 실제 클라이언트 자료, 저작권 있는 서적·논문.

---

## 5. 구현 순서

각 단계는 이전 단계 없이 시작하지 않는다. **단계마다 실제로 돌려서 확인한 뒤** 다음으로 넘어간다.

### 1단계 — 인프라
- `docker-compose.yml`: pgvector 포함 Postgres 17
- 스키마: `documents`, `chunks`(content, embedding vector, doc_id, position, metadata), HNSW 인덱스
- `.env.example` 채우기: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `DATABASE_URL`
- **확인:** `docker compose up` → 마이그레이션 성공 → 빈 테이블 조회됨

### 2단계 — Ingest
- 파서: PDF, DOCX, Markdown, TXT, HTML
- 청킹: 문단/헤딩 경계 인식. 고정 토큰 슬라이싱 금지 — 문장이 잘리면 검색 품질이 무너진다. 청크 크기와 오버랩은 **설정값**으로 빼고 기본값을 기록한다
- 로컬 배치 임베딩 → pgvector 저장
- 재수집 경로(문서 갱신 시 해당 doc의 청크만 교체) — 문서가 바뀌면 봇이 조용히 낡는다
- **확인:** 코퍼스 전체 ingest 성공, 청크 수 / 소요 시간 기록

### 3단계 — Retrieve
- 벡터 검색 top-20 → 로컬 크로스 인코더 rerank → top-N
- **리랭킹 on/off 스위치를 반드시 남긴다.** 포트폴리오의 "before/after" 수치가 여기서 나온다
- **확인:** 질문 몇 개 넣어 상위 청크가 말이 되는지 눈으로 본다

### 4단계 — Answer
- 시스템 프롬프트: 검색된 청크만 근거로 답하고, 근거가 없으면 "모른다"고 말하고, `[chunk_id]`로 인용
- 스트리밍, `effort: "low"` 또는 `"medium"`. 모델은 `config.answerModel` 을 따른다
- 서버에서 인용 ID → 실제 청크 매칭
- **확인:** 답변에 인용이 붙고, 그 인용이 실제 원문과 일치하는지 손으로 검증

### 5단계 — Eval 하네스 ★ 포트폴리오의 핵심
- `eval/questions.yaml`: 20~30개 질문 + 각 질문의 정답 청크 ID
- 측정 지표:
  - **recall@5** — 정답 청크가 상위 5개에 들어온 비율
  - **MRR@10**
  - **citation accuracy** — 답변의 인용이 실제로 근거를 담고 있는 비율
  - **answer correctness** — LLM 을 judge 로 사용 (judge 프롬프트는 별도 파일로 분리, 채점 기준 명시)
- **리랭킹 on/off 두 번 돌려 비교표를 만든다**
- 결과를 `eval/results/`에 타임스탬프와 함께 저장하고 커밋
- **확인:** 표가 나온다. 이 표가 이 레포의 모든 주장의 근거다

### 6단계 — UI
- 스트리밍 채팅, 인용 클릭 시 원문 청크 표시
- 여기서 화려하게 만들지 말 것. 인용이 잘 보이는 게 전부다

### 7단계 — 결과 정리
- `docs/portfolio.md`: 문제 → 접근 → **실측 수치** → 스크린샷
- 첫 이미지는 UI 스크린샷이 아니라 **수치 카드**다 (`public/results-card.html`)

---

## 6. Eval 설계 주의점

- **정답 라벨을 모델에게 만들게 하지 않는다.** 자기 채점이 된다. PostgreSQL 코퍼스를 고른 이유가
  이것이다 — 라벨을 **띄워둔 Postgres 17에 직접 물어서 검증한다.** `SHOW`, `\d`, `pg_settings` 조회,
  실제 명령 실행. 검증 방법을 질문마다 `verified_by` 필드에 적어둔다
- 질문은 **정답 문단이 특정되는** 것으로. "이 문서의 요지는?" 같은 건 검색 품질을 재지 못한다.
  좋은 예: *"`work_mem` 기본값과 단위는?"*, *"`VACUUM FULL`이 `VACUUM`과 달리 요구하는 락은?"*,
  *"`pg_dumpall`로는 되는데 `pg_dump`로는 안 되는 것은?"*
- **질문의 1/3 이상을 혼동 지점에 배치한다.** 이름이 비슷한 파라미터, 헷갈리는 도구 쌍, 버전별 변경,
  deprecated 항목. 리랭킹이 이기는 걸 보여줄 수 있는 유일한 방법이다. 쉬운 질문만 모으면 before/after
  표가 밋밋해지고 무엇이 값을 했는지 알 수 없게 된다
- judge에는 정답 문단을 같이 준다. 안 주면 judge가 자기 사전지식으로 채점한다 — 특히 PostgreSQL은
  모델이 이미 잘 아는 주제라 코퍼스를 안 보고도 맞힐 수 있다. **judge는 "검색된 근거만으로 이 답이
  뒷받침되는가"를 채점해야지 "답이 사실인가"를 채점하면 안 된다.** 이건 이 코퍼스의 유일한 함정이니
  judge 프롬프트에 명시할 것
- 실패 케이스를 지우지 말고 남긴다. "26개 중 23개 통과, 실패 3개는 설정 표가 여러 페이지에 걸친 경우"
  — 이런 게 포트폴리오에서 신뢰를 만든다

---

## 7. 막혔을 때

- 코퍼스 라이선스가 애매하면 → **사용자에게 묻는다**
- 임베딩 모델을 못 받으면 → 네트워크를 확인한다. 한 번 받으면 `.models/` 에 캐시되어 오프라인으로 돈다
- 스택을 바꾸고 싶으면 → `docs/decisions.md`를 먼저 읽고, 그래도 바꿔야 한다면 **묻는다.** 측정 결과는 특정 스택 위에서 나온 값이라 스택이 바뀌면 전부 다시 재야 한다

---

## 8. 현재 상태와 다음 작업 (2026-07-29)

> **구현·측정·문서가 모두 끝났고 `main` 에 커밋되어 있다.**
> 남은 일은 **별도 측정 사이클이 필요한 것들**이다 — 아래 "다음 작업" 참조.

### 개발 환경을 다시 띄우는 절차 (재부팅 후)

1. **WSL Postgres.** WSL 이 유휴 시 종료되면 Postgres 도 같이 죽는다. 그리고
   **WSL VM 이 떠 있지 않으면 Windows 에서 `localhost:5432` 로 못 간다** — WSL 안에서
   `pg_isready` 가 성공해도 그렇다. 포트 포워딩이 VM 에 붙어 있기 때문이다.
   ```powershell
   wsl -u root -e sleep infinity    # 별도로 띄워둔다 — WSL 이 안 죽게 붙잡는 역할
   ```
   확인은 **Windows 쪽에서** 한다: `npm run ask -- "…" --retrieve-only`
2. **CLIProxyAPI** (`<홈>\tools\CLIProxyAPI\cli-proxy-api.exe --config config.yaml`,
   `127.0.0.1:8317`). 확인: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8317/v1/models`
   → `401` 이면 살아 있다.
3. 재수집은 필요 없다. 코퍼스는 파서 수정 반영본이 들어가 있다.

### 측정된 것 — 46문항, 답변 품질 (출시 구성)

| 지표 | 리랭킹 OFF | 리랭킹 ON |
|---|---|---|
| recall@5 | 0.957 | **0.978** |
| MRR@10 | 0.778 | **0.853** |
| recall@5 (함정 질문만) | 0.947 | **1.000** |
| citation validity | 1.000 | **1.000** |
| grounded | 1.000 | **1.000** |
| correct | **1.000** | 0.978 |

두 조건 합쳐 **인용 168건 중 환각 0건.** 유일한 오답은 q012 이고, judge 판정문은
"발췌에 없어서 없다고 말했다"는 것 — 즉 검색 실패가 환각이 되지 않았다.

### 측정된 것 — 46문항, 증상 표현 (검색 지표, 전부 실측)

| 구성 (리랭킹 ON) | recall@5 | MRR@10 | 혼동 recall@5 |
|---|---|---|---|
| 벡터 검색만 (리랭킹 OFF) | 0.652 | 0.467 | 0.684 |
| \+ 리랭킹 | 0.783 | 0.527 | 0.842 |
| \+ 쿼리 재작성 (리랭커는 원문으로 채점) | 0.848 | 0.606 | 0.921 |
| \+ 리랭커에도 확장 질의 (**출시 구성**) | **0.978** | **0.853** | **1.000** |
| 위 + 하이브리드 ON | 0.978 | 0.865 | 1.000 |

식별자 표현 46문항: 베이스라인 0.978 → 재작성 0.957 (**개선 없음**), MRR 0.857 → 0.865.

재작성 비용: 평균 4,066ms / 최대 12,648ms, 질문당 입력 약 630토큰, 실패 0건.

코퍼스 **5,012 청크 / 309 문서, ingest 550초** (파서 수정 반영본).

근거: [`docs/decisions.md`](docs/decisions.md) D14(파서 결함) · D15(쿼리 재작성).

### 이번에 끝낸 것

- **쿼리 재작성** (`src/lib/retrieve/rewrite.ts`) — 옛 §8의 2-1. 측정 완료, 기본값 ON.
- **`RERANK_QUERY=original|expanded`** — 재작성을 켜면 리랭커도 확장 질의로 채점해야 한다.
  원문으로 채점하면 재작성이 찾아낸 6문항을 도로 밀어낸다 (0.957 → 0.848). D15.
- **질문 26 → 46개** — 옛 §8의 3. 26개에서는 recall@5 가 1.000 으로 포화돼 변별력이 없었다.
  전부 `boot_val` 로 실행 검증했고 라벨 46개 모두 유효(`npm run check-gold`).
- **파서·청커 결함 3개 수정** — HTML 태그 유출 384청크 → 0, 512토큰 초과 137개(최대 8,060) → 1.
  전부 회귀 테스트 추가. **지표는 이 결함들을 전혀 잡지 못했다** — D14.
- **재작성 캐시**(`eval/rewrite-cache.json`, 커밋 대상) — 재작성이 비결정적이라 동일 설정
  두 실행이 recall 0.962/1.000 으로 갈렸다. 얼려야 A/B 가 성립한다.
- UI 에 재작성 질의 표시 + 토글, `maxRetries: 5`.

### ⚠️ 정답 라벨을 만들 때 `SHOW` 를 쓰지 말 것

`pg_settings.setting` 은 **지금 돌고 있는 값**이라 배포판 postgresql.conf 오버라이드가 섞인다.
이 인스턴스에서 실측: `ssl` 실행값 `on` / 문서 기본값 `off`,
`log_line_prefix` 실행값 `%m [%p] %q%u@%d ` / 기본값 `%m [%p] `.
**설정 기본값은 반드시 `boot_val` 로 확인한다.** q001~q026 도 재점검했고 영향 없음을 확인했다.

### 다음 작업 — 우선순위 순

1. **짧은 정의 청크 문제** — 남은 유일한 검색 실패(q012)의 원인. `<dt>` 를 헤딩으로 올리는
   규칙이 혼동 질문 recall 1.000 을 만든 바로 그 규칙인데, 정의가 한 줄이면
   ("Output a plain-text SQL script file (the default).") 검색되기엔 너무 작은 청크가 된다.
   짧은 정의를 부모에 되붙이면 파라미터 분리가 깨질 위험이 있다 — **별도 측정 사이클 필요.**
2. **두 번째 코퍼스** — 일반화 증거. 특히 **모델이 모르는 코퍼스**여야 재작성 이득이
   사전지식 덕인지 검색 덕인지 갈린다 (D15).

### 건드리지 말 것

- **judge 를 구조화 출력(`json_schema`)에 의존하게 되돌리지 말 것.** 프록시가 조용히 무시한다 (§2).
- **`recall@5` 라벨을 느슨하게 만들지 말 것.** 숫자는 오르지만 의미가 흐려진다. 지금 지표는
  하한이고, 그 사실이 `docs/portfolio.md` 에 적혀 있다.
- **임베딩·리랭킹을 관리형 API 로 되돌리지 말 것** (D11).
- **`RERANK_QUERY` 를 `original` 로 되돌리지 말 것.** 재작성을 켠 상태에서 recall@5 를
  0.978 → 0.848 로 떨어뜨린다 (D15). "리랭커에는 사용자의 원래 질문을 줘야 한다"는 직관이
  여기서는 틀렸다.
- **`eval/rewrite-cache.json` 을 무심코 지우지 말 것.** 지우면 재작성이 다시 뽑히고
  **커밋된 수치가 재현되지 않는다.** 지웠으면 표를 다시 내야 한다 (D15).
- **`<dt>` 를 헤딩으로 올리는 규칙을 되돌리지 말 것.** 짧은 정의 청크 문제(위 4번)를 고치려고
  건드리기 쉬운데, 이 규칙이 혼동 질문 recall 1.000 의 근거다. 반드시 재측정과 함께.
