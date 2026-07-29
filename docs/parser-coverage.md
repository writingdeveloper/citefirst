# 파서 커버리지

지원한다고 적은 포맷 5종(PDF, Word, Markdown, HTML, plain text)에 대한 실측 기록.
`npx tsx scripts/parser-check.ts` 로 재현한다.

| 포맷 | 파일 | 크기 | 블록 | 청크 | 시간 | 결과 |
|---|---|---|---|---|---|---|
| html | `corpus\html\postgresql-17.10\doc\src\sgml\html\acronyms.html` | 21 KB | 85 | 85 | 7ms | ✅ |
| txt | `corpus\raw\COPYRIGHT` | 1 KB | 6 | 1 | 1ms | ✅ |
| md | `README.md` | 28 KB | 114 | 17 | 1ms | ✅ |

**미검증 포맷: pdf, docx** — 파서 코드는 있지만 실제 파일로 태워보지 않았다. 검증 전에는 증명된 것으로 취급하지 않는다.

## 첫 청크 표본

**html** — `corpus\html\postgresql-17.10\doc\src\sgml\html\acronyms.html`

> This is a list of acronyms commonly used in the PostgreSQL documentation and in discussions about PostgreSQL.…

**txt** — `corpus\raw\COPYRIGHT`

> PostgreSQL Database Management System (also known as Postgres, formerly known as Postgres95) Portions Copyright (c) 199…

**md** — `README.md`

> # citefirst A RAG system that answers from your documents — with citations verified against the retrieved chunks befor…
