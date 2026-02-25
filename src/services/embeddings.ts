import crypto from "crypto";
import { loadEnv } from "../config/env.js";
import { prisma } from "../db/client.js";

const env = loadEnv();

type EmbeddingResponse = {
  data: Array<{ embedding: number[]; index: number }>;
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

async function fetchEmbeddings(inputs: string[]): Promise<number[][]> {
  const base = env.openaiBaseUrl.replace(/\/$/, "");
  const url = `${base}/embeddings`;
  const body: Record<string, any> = {
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
    const json = (await res.json()) as EmbeddingResponse;
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  } finally {
    clearTimeout(timeout);
  }
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const batchSize = env.openaiEmbeddingsBatchSize;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts
      .slice(i, i + batchSize)
      .map((text) => truncateInput(normalizeInput(text)));
    let attempt = 0;
    while (true) {
      try {
        const vectors = await fetchEmbeddings(batch);
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

export async function embedText(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  return vector;
}

export async function embedQueryWithCache(params: {
  repoId: number;
  query: string;
}): Promise<number[]> {
  const raw = params.query.trim();
  if (raw.length === 0) return embedText(" ");
  const text = raw.length > 2000 ? raw.slice(0, 2000) : raw;
  const hash = crypto.createHash("sha1").update(text).digest("hex");
  // Store query embeddings with kind = "query" and textHash in metadata
  const existing = await prisma.embedding.findFirst({
    where: {
      repoId: params.repoId,
      kind: "query",
      text: hash
    }
  });
  if (existing?.vector?.length) return existing.vector as number[];

  const vector = await embedText(text);
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
