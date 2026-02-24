import { prisma } from "../db/client.js";
import { cosineSimilarity, embedQueryWithCache } from "./embeddings.js";

export type RetrievalResult = {
  kind: "file" | "symbol";
  score: number;
  path?: string;
  symbol?: string;
  text: string;
  isPattern?: boolean;
};

export async function retrieveContext(params: {
  repoId: number;
  query: string;
  topK?: number;
}): Promise<RetrievalResult[]> {
  const topK = params.topK ?? 8;
  const queryVec = await embedQueryWithCache({ repoId: params.repoId, query: params.query });
  const embeddings = await prisma.embedding.findMany({
    where: { repoId: params.repoId, kind: { in: ["file", "symbol"] } },
    take: 5000
  });
  const fileMap = new Map<number, { path: string; isPattern: boolean }>();
  const files = await prisma.fileIndex.findMany({ where: { repoId: params.repoId } });
  for (const file of files) {
    fileMap.set(file.id, { path: file.path, isPattern: file.isPattern });
  }

  const symbolMap = new Map<number, string>();
  const symbols = await prisma.symbol.findMany({ where: { repoId: params.repoId } });
  for (const sym of symbols) {
    symbolMap.set(sym.id, sym.name);
  }

  const scored = embeddings.map((embedding) => ({
    embedding,
    score: cosineSimilarity(queryVec, embedding.vector)
  }));

  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, topK);
  return selected.map(({ embedding, score }) => ({
    kind: embedding.kind === "symbol" ? "symbol" : "file",
    score,
    path: embedding.fileId ? fileMap.get(embedding.fileId)?.path : undefined,
    symbol: embedding.symbolId ? symbolMap.get(embedding.symbolId) : undefined,
    text: embedding.text,
    isPattern: embedding.fileId ? fileMap.get(embedding.fileId)?.isPattern : undefined
  }));
}
