import { prisma } from "../db/client.js";
import { cosineSimilarity, embedQueryWithCache } from "./embeddings.js";

export type RetrievalResult = {
  kind: "file" | "symbol";
  score: number;
  path?: string;
  symbol?: string;
  text: string;
  isPattern?: boolean;
  signals?: {
    semantic: number;
    lexical: number;
    pathBoost: number;
  };
};

export async function retrieveContext(params: {
  repoId: number;
  query: string;
  topK?: number;
  changedPaths?: string[];
}): Promise<RetrievalResult[]> {
  const topK = params.topK ?? 8;
  const changedPaths = new Set(
    (params.changedPaths || []).map((value) => value.trim().toLowerCase()).filter(Boolean)
  );
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

  const queryTokens = tokenize(params.query);

  const scored = embeddings.map((embedding) => {
    const path = embedding.fileId ? fileMap.get(embedding.fileId)?.path : undefined;
    const symbol = embedding.symbolId ? symbolMap.get(embedding.symbolId) : undefined;
    const semantic = cosineSimilarity(queryVec, embedding.vector);
    const lexical = lexicalSimilarity(
      queryTokens,
      tokenize(`${path || ""} ${symbol || ""} ${embedding.text.slice(0, 2000)}`)
    );
    const pathBoost = path ? computePathBoost(path, changedPaths) : 0;
    const patternBoost = embedding.fileId && fileMap.get(embedding.fileId)?.isPattern ? 0.03 : 0;
    const score = semantic * 0.72 + lexical * 0.24 + pathBoost + patternBoost;
    return {
      embedding,
      path,
      symbol,
      semantic,
      lexical,
      pathBoost,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: typeof scored = [];
  const seen = new Set<string>();
  const perPath = new Map<string, number>();
  const maxPerPath = 2;

  for (const item of scored) {
    const key = `${item.embedding.kind}|${item.path || ""}|${item.symbol || ""}|${item.embedding.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pathKey = (item.path || "").toLowerCase();
    if (pathKey) {
      const count = perPath.get(pathKey) || 0;
      if (count >= maxPerPath && selected.length < topK) {
        continue;
      }
      perPath.set(pathKey, count + 1);
    }
    selected.push(item);
    if (selected.length >= topK) break;
  }

  return selected.map((item) => ({
    kind: item.embedding.kind === "symbol" ? "symbol" : "file",
    score: item.score,
    path: item.path,
    symbol: item.symbol,
    text: item.embedding.text,
    isPattern: item.embedding.fileId ? fileMap.get(item.embedding.fileId)?.isPattern : undefined,
    signals: {
      semantic: item.semantic,
      lexical: item.lexical,
      pathBoost: item.pathBoost
    }
  }));
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "is",
  "are",
  "be",
  "from",
  "by",
  "with",
  "this",
  "that",
  "it",
  "as"
]);

function tokenize(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return new Set(tokens);
}

function lexicalSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(a.size * b.size);
}

function computePathBoost(path: string, changedPaths: Set<string>): number {
  if (changedPaths.size === 0) return 0;
  const normalized = path.toLowerCase();
  if (changedPaths.has(normalized)) return 0.12;
  const pathDir = directoryPath(normalized);
  for (const changed of changedPaths) {
    if (!changed) continue;
    if (directoryPath(changed) === pathDir && pathDir.length > 0) return 0.06;
  }
  return 0;
}

function directoryPath(value: string): string {
  const idx = value.lastIndexOf("/");
  return idx === -1 ? "" : value.slice(0, idx);
}
