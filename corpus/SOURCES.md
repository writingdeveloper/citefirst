# 코퍼스 출처 — PostgreSQL 17 공식 문서

문서 파일은 **커밋하지 않는다** (`.gitignore` 참조). 여기에 출처와 이용 조건만 기록하고,
`scripts/fetch-corpus.ts` 로 로컬에서 내려받는다.

선택 근거: [`docs/decisions.md`](../docs/decisions.md) D9 · 범위: [`AGENTS.md`](../AGENTS.md) §4

---

## 규칙

- 각 항목마다 **URL + 발행 주체 + 이용 조건 + 확인일**을 채운다
- **이용 조건은 1차 출처에서 확인한다.** 배포물 안의 저작권 고지 파일(`COPYRIGHT` 등)을 실제로 열어
  읽고, 전문을 아래 "라이선스 원문"에 옮긴다. 이 레포의 다른 문서 서술을 근거로 삼지 않는다
- 확인이 안 되면 **쓰지 않는다.** 애매하면 사용자에게 묻는다
- 사용자 개인 문서, 실제 클라이언트 자료, 저작권 있는 서적·논문은 **금지**

---

## 목록

| # | 문서 | 포맷 | 발행 주체 | URL | 이용 조건 | 확인일 |
|---|---|---|---|---|---|---|
| 1 | PostgreSQL 17.10 Documentation (HTML tarball, 1142개 파일) | HTML | PostgreSQL Global Development Group | `https://ftp.postgresql.org/pub/source/v17.10/postgresql-17.10-docs.tar.gz` (3,822,749 B) | PostgreSQL License (아래 원문) | 2026-07-28 |
| 2 | `COPYRIGHT` | TXT | PostgreSQL Global Development Group | `https://raw.githubusercontent.com/postgres/postgres/REL_17_10/COPYRIGHT` (1,198 B) | 자기 자신이 라이선스 원문 | 2026-07-28 |
| 3 | `README.md` | MD | PostgreSQL Global Development Group | `https://raw.githubusercontent.com/postgres/postgres/REL_17_10/README.md` | PostgreSQL License | 2026-07-28 |
| 4 | PostgreSQL 17 Documentation (PDF, A4) | PDF | PostgreSQL Global Development Group | `https://www.postgresql.org/files/documentation/pdf/17/postgresql-17-A4.pdf` (15,435,019 B) | PostgreSQL License | 2026-07-28 |

4번(PDF)은 **검색 코퍼스에 넣지 않는다** — HTML과 같은 내용이라 중복 청크가 생기고 eval 정답
라벨이 쪼개진다([`docs/decisions.md`](../docs/decisions.md) D10). 파서 커버리지 증명 전용이며
`npm run corpus:fetch -- --with-pdf` 로만 받는다.

포맷을 섞는 이유: 지원한다고 적은 포맷이 PDF·Word·Markdown·HTML·plain text 다섯 종이다.
파서를 실제로 태워봐야 그 주장이 증명된다. 결과는 [`docs/parser-coverage.md`](../docs/parser-coverage.md).

---

## 라이선스 원문

배포물의 `COPYRIGHT` 파일(`corpus/raw/COPYRIGHT`)에서 그대로 옮긴 전문. 2026-07-28 확인.

```
PostgreSQL Database Management System
(also known as Postgres, formerly known as Postgres95)

Portions Copyright (c) 1996-2026, PostgreSQL Global Development Group

Portions Copyright (c) 1994, The Regents of the University of California

Permission to use, copy, modify, and distribute this software and its
documentation for any purpose, without fee, and without a written agreement
is hereby granted, provided that the above copyright notice and this
paragraph and the following two paragraphs appear in all copies.

IN NO EVENT SHALL THE UNIVERSITY OF CALIFORNIA BE LIABLE TO ANY PARTY FOR
DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING
LOST PROFITS, ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS
DOCUMENTATION, EVEN IF THE UNIVERSITY OF CALIFORNIA HAS BEEN ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

THE UNIVERSITY OF CALIFORNIA SPECIFICALLY DISCLAIMS ANY WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS
ON AN "AS IS" BASIS, AND THE UNIVERSITY OF CALIFORNIA HAS NO OBLIGATIONS TO
PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
```

**요약:**
- **재배포 허용 여부:** 허용. *"Permission to use, copy, modify, and distribute this software and its documentation for any purpose, without fee, and without a written agreement"* — 목적 제한이 없고 상업적 이용도 포함된다.
- **저작권 고지 유지 의무:** 있음. 위 저작권 문구와 뒤따르는 두 단락을 **모든 사본에 포함**해야 한다. 그래서 이 파일에 전문을 그대로 둔다.
- **포트폴리오/데모 사용 가능 여부:** 가능. 다만 코퍼스 파일 자체는 `.gitignore` 로 커밋하지 않고 `scripts/fetch-corpus.ts` 로 받게 한다 — 라이선스 때문이 아니라 레포 크기 때문이다.
- **주의:** 이 조항은 **문서에도 적용된다**("this software and its documentation"). 문서만 따로 떼어낸 별도 라이선스가 있는 게 아니다.

---

## ingest 범위 (1차)

전체 문서는 크다. 아래로 좁혀 시작하고 부족하면 넓힌다. 혼동 지점이 이 범위에 다 들어있어서
검색 난이도는 유지된다.

- Server Administration
- SQL Commands
- Client Applications / Server Applications
- Server Configuration

**기록할 것:** 실제 ingest한 섹션, 문서 수, 청크 수, 소요 시간 → `docs/portfolio.md`

---

## 정답 검증 방법

이 코퍼스를 고른 핵심 이유. eval 질문의 정답 라벨을 **띄워둔 Postgres 17에 직접 물어서 확인한다.**

| 질문 유형 | 검증 방법 |
|---|---|
| 설정 파라미터 기본값·단위 | `SHOW <param>;` / `SELECT * FROM pg_settings WHERE name = '<param>';` |
| 명령 동작·옵션 | 실제 실행 후 결과 확인 |
| 시스템 카탈로그 구조 | `\d <catalog>` |
| 함수 시그니처 | `\df <function>` |

각 질문의 `eval/questions.yaml` 항목에 **`verified_by` 필드로 검증 방법을 남긴다.**
검증 못 한 질문은 라벨을 신뢰할 수 없으므로 세트에서 뺀다.
