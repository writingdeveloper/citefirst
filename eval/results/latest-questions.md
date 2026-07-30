# 평가 결과

실행 2026-07-30T01:05:11.993Z · 질문 46개 · 모드 full

| 지표 | 리랭킹 OFF | 리랭킹 ON |
|---|---|---|
| recall@5 | 0.652 | 0.826 |
| MRR@10 | 0.467 | 0.544 |
| recall@5 (함정 질문만) | 0.684 | 0.868 |
| citation validity | 1.000 | 1.000 |
| grounded (근거 뒷받침) | 1.000 | 1.000 |
| correct (정답 일치) | 0.717 | 0.826 |

설정: 청크 512토큰 / 오버랩 64 · 검색 top-20 → 평가 top-10 · 임베딩 Xenova/bge-base-en-v1.5 · 리랭커 Xenova/bge-reranker-base · 답변 gpt-5.6-sol (effort low) · 하이브리드 OFF · 쿼리 재작성 OFF

원본: `2026-07-30T01-05-11-991Z.json`
