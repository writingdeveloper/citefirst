import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env as hfEnv,
  pipeline,
  type FeatureExtractionPipeline,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";

/**
 * 임베딩과 리랭킹은 **이 기계 안에서** 돈다 (docs/decisions.md D11).
 *
 * 관리형 임베딩 API(Voyage 등)를 쓰면 클라이언트 문서가 전부 제3자 서버를 거친다.
 * 이런 시스템이 겨냥하는 문서가 policies / manuals / contracts 인데, 계약서를 외부로 보내는 걸
 * 받아들일 수 없는 클라이언트가 많다. 로컬 모델이면 그 대화 자체가 필요 없다.
 *
 * 대가: bge-base 는 voyage-3 보다 작은 모델이라 검색 품질이 조금 낮을 수 있고, CPU 에서는 느리다.
 * 그 차이가 실제로 얼마인지는 eval 이 말해준다 — 추정하지 않는다.
 */

const MODEL_CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".models");
hfEnv.cacheDir = MODEL_CACHE;
// 로컬 파일만 쓰겠다는 뜻이 아니라, 원격 조회를 캐시가 있으면 건너뛰게 한다.
hfEnv.allowLocalModels = true;

let extractor: FeatureExtractionPipeline | undefined;
let rerankTokenizer: PreTrainedTokenizer | undefined;
let rerankModel: PreTrainedModel | undefined;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= await pipeline("feature-extraction", config.embeddingModel, { dtype: "fp32" });
  return extractor;
}

async function getReranker(): Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> {
  rerankTokenizer ??= await AutoTokenizer.from_pretrained(config.rerankModel);
  rerankModel ??= await AutoModelForSequenceClassification.from_pretrained(config.rerankModel, { dtype: "fp32" });
  return { tokenizer: rerankTokenizer, model: rerankModel };
}

/** 로컬 추론은 배치가 클수록 메모리를 먹는다. CPU 기준으로 안전한 크기. */
const EMBED_BATCH = 16;
const RERANK_BATCH = 8;

async function embedBatch(texts: readonly string[]): Promise<number[][]> {
  const fe = await getExtractor();
  /*
   * BGE 는 **CLS 풀링 + L2 정규화**가 정석이다. mean 풀링을 쓰면 점수 분포가 달라져
   * 코사인 거리 기준이 흐트러진다. normalize 를 빼면 pgvector 의 `<=>` 결과가
   * 코사인이 아니게 되므로 반드시 켠다.
   */
  const out = await fe([...texts], { pooling: "cls", normalize: true });
  const vectors = out.tolist() as number[][];

  for (const [i, v] of vectors.entries()) {
    if (!v || v.length !== config.embeddingDim) {
      throw new Error(
        `임베딩 차원 불일치: 모델이 ${v?.length} 차원을 반환했는데 설정은 ${config.embeddingDim} 입니다 (index ${i}). ` +
          `EMBEDDING_DIM 과 마이그레이션의 vector(...) 를 함께 맞추세요.`,
      );
    }
  }
  return vectors;
}

export async function embedDocuments(
  texts: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    out.push(...(await embedBatch(texts.slice(i, i + EMBED_BATCH))));
    onProgress?.(out.length, texts.length);
  }
  return out;
}

/**
 * 질의 여러 개를 한 번에 임베딩한다 (쿼리 재작성용).
 *
 * 배열로 넘기는 게 핵심이다 — 재작성이 질의를 3~4개로 늘리는데 하나씩 돌리면
 * 모델 forward 를 그만큼 반복하게 된다. 한 배치로 묶으면 한 번이다.
 */
export async function embedQueries(texts: readonly string[]): Promise<number[][]> {
  // 질의에만 지시문 prefix 를 붙인다 (config.queryPrefix 주석 참조).
  const prefixed = texts.map((t) => `${config.queryPrefix}${t}`);
  const out: number[][] = [];
  for (let i = 0; i < prefixed.length; i += EMBED_BATCH) {
    out.push(...(await embedBatch(prefixed.slice(i, i + EMBED_BATCH))));
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embedQueries([text]);
  return v!;
}

export interface RerankResult {
  readonly index: number;
  readonly relevanceScore: number;
}

/**
 * 크로스 인코더 리랭킹.
 *
 * 임베딩 검색은 질의와 문서를 **따로** 벡터로 만들어 비교한다. 리랭커는 둘을 **같이** 넣고
 * 관련성을 직접 점수화한다 — 그래서 `work_mem` 과 `maintenance_work_mem` 처럼
 * 벡터 공간에서 거의 붙어 있는 문단을 갈라낼 수 있다. 리랭킹이 값을 하는 지점이 정확히 이 차이다.
 */
export async function rerank(
  query: string,
  documents: readonly string[],
  topN: number,
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];
  const { tokenizer, model } = await getReranker();

  const scores: number[] = [];
  for (let i = 0; i < documents.length; i += RERANK_BATCH) {
    const batch = documents.slice(i, i + RERANK_BATCH);
    const inputs = tokenizer(Array(batch.length).fill(query) as string[], {
      text_pair: [...batch],
      padding: true,
      truncation: true,
    });
    const output = await model(inputs);
    // 이 리랭커는 라벨이 하나뿐이라 logits 이 [batch, 1] 로 나온다.
    const logits = output.logits.tolist() as number[][];
    for (const row of logits) scores.push(row[0] ?? Number.NEGATIVE_INFINITY);
  }

  return scores
    .map((relevanceScore, index) => ({ index, relevanceScore }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, topN);
}

/** 모델을 미리 받아둔다. 첫 질의에서 수백 MB 를 받느라 멈추는 걸 피할 때 쓴다. */
export async function warmup(): Promise<void> {
  await getExtractor();
  await getReranker();
}
