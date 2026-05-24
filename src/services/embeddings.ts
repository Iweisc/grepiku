import crypto from "crypto";
import { loadEnv } from "../config/env.js";
import { prisma } from "../db/client.js";

const env = loadEnv();

type EmbeddingTask = "document" | "query";

type EmbeddingOptions = {
  task?: EmbeddingTask;
};

type OpenAIEmbeddingResponse = {
  data: Array<{ embedding: number[]; index: number }>;
};

type GeminiBatchEmbeddingResponse = {
  embeddings?: Array<{ values?: number[] }>;
};

function normalizeInput(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? " " : trimmed;
}

function truncateInput(text: string): string {
  const maxChars = env.openaiEmbeddingsMaxChars;
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function embeddingModelCacheKey(task: EmbeddingTask): string {
  if (env.embeddingsProvider === "gemini") {
    return JSON.stringify({
      provider: env.embeddingsProvider,
      model: env.geminiEmbeddingsModel,
      dimensions: env.geminiEmbeddingsDimensions,
      task
    });
  }
  return JSON.stringify({
    provider: env.embeddingsProvider,
    model: env.openaiEmbeddingsModel,
    dimensions: env.openaiEmbeddingsDimensions,
    task
  });
}

async function fetchOpenAIEmbeddings(inputs: string[]): Promise<number[][]> {
  const base = env.openaiBaseUrl.replace(/\/$/, "");
  const url = `${base}/embeddings`;
  const body: Record<string, unknown> = {
    model: env.openaiEmbeddingsModel,
    input: inputs,
    encoding_format: "float"
  };
  if (env.openaiEmbeddingsDimensions) {
    body.dimensions = env.openaiEmbeddingsDimensions;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.openaiTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Embeddings API error ${res.status}: ${text}`);
    }
    const json = (await res.json()) as OpenAIEmbeddingResponse;
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  } finally {
    clearTimeout(timeout);
  }
}

function geminiModelPath(): string {
  const model = env.geminiEmbeddingsModel.trim();
  return model.startsWith("models/") ? model : `models/${model}`;
}

function geminiTaskType(task: EmbeddingTask): string | null {
  const value = task === "query"
    ? env.geminiEmbeddingsQueryTaskType
    : env.geminiEmbeddingsDocumentTaskType;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchGeminiEmbeddings(inputs: string[], task: EmbeddingTask): Promise<number[][]> {
  if (!env.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required when EMBEDDINGS_PROVIDER=gemini");
  }

  const base = env.geminiEmbeddingsBaseUrl.replace(/\/$/, "");
  const model = geminiModelPath();
  const url = new URL(`${base}/${model}:batchEmbedContents`);
  url.searchParams.set("key", env.geminiApiKey);
  const taskType = geminiTaskType(task);

  const requests = inputs.map((text) => {
    const request: Record<string, unknown> = {
      model,
      content: {
        parts: [{ text }]
      }
    };
    if (taskType) {
      request.taskType = taskType;
    }
    if (env.geminiEmbeddingsDimensions) {
      request.outputDimensionality = env.geminiEmbeddingsDimensions;
    }
    return request;
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.openaiTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ requests }),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini embeddings API error ${res.status}: ${text}`);
    }
    const json = (await res.json()) as GeminiBatchEmbeddingResponse;
    return (json.embeddings || []).map((item) => item.values || []);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEmbeddings(inputs: string[], task: EmbeddingTask): Promise<number[][]> {
  if (env.embeddingsProvider === "gemini") {
    return fetchGeminiEmbeddings(inputs, task);
  }
  return fetchOpenAIEmbeddings(inputs);
}

export async function embedTexts(texts: string[], options: EmbeddingOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return [];
  const batchSize = env.openaiEmbeddingsBatchSize;
  const task = options.task ?? "document";
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts
      .slice(i, i + batchSize)
      .map((text) => truncateInput(normalizeInput(text)));
    let attempt = 0;
    while (true) {
      try {
        const vectors = await fetchEmbeddings(batch, task);
        if (vectors.length !== batch.length) {
          throw new Error(`Embeddings API returned ${vectors.length} vectors for ${batch.length} inputs`);
        }
        results.push(...vectors);
        break;
      } catch (err) {
        attempt += 1;
        if (attempt > env.openaiMaxRetries) throw err;
        const backoff = Math.min(2000 * attempt, 10000);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  return results;
}

export async function embedText(text: string, options: EmbeddingOptions = {}): Promise<number[]> {
  const [vector] = await embedTexts([text], options);
  return vector;
}

export async function embedQueryWithCache(params: {
  repoId: number;
  query: string;
}): Promise<number[]> {
  const raw = params.query.trim();
  if (raw.length === 0) return embedText(" ", { task: "query" });
  const text = raw.length > 2000 ? raw.slice(0, 2000) : raw;
  const hash = crypto
    .createHash("sha1")
    .update(`${embeddingModelCacheKey("query")}\n${text}`)
    .digest("hex");
  const existing = await prisma.embedding.findFirst({
    where: {
      repoId: params.repoId,
      kind: "query",
      text: hash
    }
  });
  if (existing?.vector?.length) return existing.vector as number[];

  const vector = await embedText(text, { task: "query" });
  await prisma.embedding.create({
    data: {
      repoId: params.repoId,
      kind: "query",
      vector,
      text: hash
    }
  });
  return vector;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (!aNorm || !bNorm) return 0;
  return dot / Math.sqrt(aNorm * bNorm);
}
