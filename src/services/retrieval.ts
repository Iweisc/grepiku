import { prisma } from "../db/client.js";
import { cosineSimilarity, embedQueryWithCache } from "./embeddings.js";

export type RetrievalResult = {
  kind: "file" | "symbol" | "chunk";
  score: number;
  path?: string;
  symbol?: string;
  text: string;
  isPattern?: boolean;
  signals?: {
    semantic: number;
    lexical: number;
    pathBoost: number;
    kindBoost: number;
    patternBoost: number;
    rrf: number;
  };
};

export type RetrievalWeights = {
  semanticWeight: number;
  lexicalWeight: number;
  rrfWeight: number;
  changedPathBoost: number;
  sameDirectoryBoost: number;
  patternBoost: number;
  symbolBoost: number;
  chunkBoost: number;
};

const DEFAULT_WEIGHTS: RetrievalWeights = {
  semanticWeight: 0.62,
  lexicalWeight: 0.22,
  rrfWeight: 0.08,
  changedPathBoost: 0.16,
  sameDirectoryBoost: 0.08,
  patternBoost: 0.03,
  symbolBoost: 0.02,
  chunkBoost: 0.03
};

const EMBEDDING_FETCH_BATCH = 2000;
const EMBEDDING_FETCH_MAX = 80000;

type EmbeddingRow = {
  id: number;
  fileId: number | null;
  symbolId: number | null;
  kind: string;
  vector: number[];
  text: string;
};

type RankedRetrievalItem = {
  embedding: { id: number };
  path?: string;
  score: number;
};

export async function retrieveContext(params: {
  repoId: number;
  query: string;
  topK?: number;
  maxPerPath?: number;
  changedPaths?: string[];
  weights?: Partial<RetrievalWeights>;
}): Promise<RetrievalResult[]> {
  const topK = Math.max(4, Math.min(60, params.topK ?? 18));
  const maxPerPath = Math.max(1, Math.min(12, params.maxPerPath ?? 4));
  const weights = mergeWeights(params.weights);
  const changedPaths = new Set(
    (params.changedPaths || [])
      .map((value) => normalizeRepoPath(value))
      .filter(Boolean)
  );
  const changedDirectories = new Set(
    Array.from(changedPaths)
      .map((value) => directoryPath(value))
      .filter(Boolean)
  );

  const queryVec = await embedQueryWithCache({ repoId: params.repoId, query: params.query });
  const [embeddings, files, symbols] = await Promise.all([
    loadRepoEmbeddings(params.repoId),
    prisma.fileIndex.findMany({ where: { repoId: params.repoId }, select: { id: true, path: true, isPattern: true } }),
    prisma.symbol.findMany({ where: { repoId: params.repoId }, select: { id: true, name: true } })
  ]);

  const fileMap = new Map<number, { path: string; isPattern: boolean }>();
  for (const file of files) {
    fileMap.set(file.id, { path: normalizeRepoPath(file.path), isPattern: file.isPattern });
  }

  const symbolMap = new Map<number, string>();
  for (const sym of symbols) {
    symbolMap.set(sym.id, sym.name);
  }

  const queryTokens = tokenize(params.query);
  const queryPathHints = extractPathHints(params.query);

  const scored = embeddings.map((embedding) => {
    const fileMeta = embedding.fileId ? fileMap.get(embedding.fileId) : undefined;
    const path = fileMeta?.path;
    const symbol = embedding.symbolId ? symbolMap.get(embedding.symbolId) : undefined;
    const semanticRaw = cosineSimilarity(queryVec, embedding.vector);
    const semantic = normalizeCosine(semanticRaw);
    const lexical = lexicalSimilarity(
      queryTokens,
      tokenize(buildLexicalInput({ path, symbol, text: embedding.text }))
    );
    const pathBoost = path
      ? computePathBoost({
          path,
          changedPaths,
          changedDirectories,
          queryPathHints,
          changedPathBoost: weights.changedPathBoost,
          sameDirectoryBoost: weights.sameDirectoryBoost
        })
      : 0;
    const patternBoost = fileMeta?.isPattern ? weights.patternBoost : 0;
    const kindBoost =
      embedding.kind === "symbol"
        ? weights.symbolBoost
        : embedding.kind === "chunk"
          ? weights.chunkBoost
          : 0;

    return {
      embedding,
      path,
      symbol,
      semantic,
      lexical,
      pathBoost,
      patternBoost,
      kindBoost,
      rrf: 0,
      score: 0
    };
  });

  applyRrfScores(scored);

  for (const item of scored) {
    item.score =
      item.semantic * weights.semanticWeight +
      item.lexical * weights.lexicalWeight +
      item.rrf * weights.rrfWeight +
      item.pathBoost +
      item.patternBoost +
      item.kindBoost;
  }

  scored.sort((a, b) => b.score - a.score);

  const selected = selectRankedRetrievalItems({
    scored,
    topK,
    maxPerPath,
    changedPaths
  });

  return selected.map((item) => ({
    kind: mapEmbeddingKind(item.embedding.kind),
    score: item.score,
    path: item.path,
    symbol: item.symbol,
    text: item.embedding.text,
    isPattern: item.path && item.embedding.fileId ? fileMap.get(item.embedding.fileId)?.isPattern : undefined,
    signals: {
      semantic: item.semantic,
      lexical: item.lexical,
      pathBoost: item.pathBoost,
      kindBoost: item.kindBoost,
      patternBoost: item.patternBoost,
      rrf: item.rrf
    }
  }));
}

function mergeWeights(overrides?: Partial<RetrievalWeights>): RetrievalWeights {
  if (!overrides) return DEFAULT_WEIGHTS;
  return {
    semanticWeight: sanitizeWeight(overrides.semanticWeight, DEFAULT_WEIGHTS.semanticWeight),
    lexicalWeight: sanitizeWeight(overrides.lexicalWeight, DEFAULT_WEIGHTS.lexicalWeight),
    rrfWeight: sanitizeWeight(overrides.rrfWeight, DEFAULT_WEIGHTS.rrfWeight),
    changedPathBoost: sanitizeWeight(overrides.changedPathBoost, DEFAULT_WEIGHTS.changedPathBoost),
    sameDirectoryBoost: sanitizeWeight(overrides.sameDirectoryBoost, DEFAULT_WEIGHTS.sameDirectoryBoost),
    patternBoost: sanitizeWeight(overrides.patternBoost, DEFAULT_WEIGHTS.patternBoost),
    symbolBoost: sanitizeWeight(overrides.symbolBoost, DEFAULT_WEIGHTS.symbolBoost),
    chunkBoost: sanitizeWeight(overrides.chunkBoost, DEFAULT_WEIGHTS.chunkBoost)
  };
}

function sanitizeWeight(input: number | undefined, fallback: number): number {
  if (!Number.isFinite(input)) return fallback;
  if (!input || input < 0) return 0;
  return Math.min(input, 1);
}

export async function loadRepoEmbeddings(repoId: number) {
  const rows: EmbeddingRow[] = [];
  let cursor: number | null = null;

  while (rows.length < EMBEDDING_FETCH_MAX) {
    const batch = (await prisma.embedding.findMany({
      where: {
        repoId,
        kind: { in: ["file", "symbol", "chunk"] }
      },
      orderBy: { id: "desc" },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take: EMBEDDING_FETCH_BATCH,
      select: {
        id: true,
        fileId: true,
        symbolId: true,
        kind: true,
        vector: true,
        text: true
      }
    })) as EmbeddingRow[];

    if (batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < EMBEDDING_FETCH_BATCH) break;
    cursor = batch[batch.length - 1].id;
  }

  return rows.slice(0, EMBEDDING_FETCH_MAX);
}

function mapEmbeddingKind(kind: string): RetrievalResult["kind"] {
  if (kind === "symbol") return "symbol";
  if (kind === "chunk") return "chunk";
  return "file";
}

export function selectRankedRetrievalItems<T extends RankedRetrievalItem>(params: {
  scored: T[];
  topK: number;
  maxPerPath: number;
  changedPaths: Set<string>;
}): T[] {
  const selected: T[] = [];
  const selectedIds = new Set<number>();
  const perPathCount = new Map<string, number>();
  const overflow: T[] = [];

  const selectItem = (item: T) => {
    selected.push(item);
    selectedIds.add(item.embedding.id);
    if (item.path) {
      perPathCount.set(item.path, (perPathCount.get(item.path) || 0) + 1);
    }
  };

  const anchorSlots = Math.min(params.topK, Math.max(2, Math.ceil(params.topK / 3)));
  if (params.changedPaths.size > 0 && anchorSlots > 0) {
    const bestByChangedPath = new Map<string, T>();
    for (const item of params.scored) {
      if (!item.path || !params.changedPaths.has(item.path)) continue;
      const existing = bestByChangedPath.get(item.path);
      if (!existing || item.score > existing.score) {
        bestByChangedPath.set(item.path, item);
      }
    }
    const anchors = Array.from(bestByChangedPath.values()).sort((a, b) => b.score - a.score);
    for (const item of anchors) {
      if (selected.length >= anchorSlots) break;
      selectItem(item);
    }
  }

  for (const item of params.scored) {
    if (selected.length >= params.topK) break;
    if (selectedIds.has(item.embedding.id)) continue;
    const pathKey = item.path || "";
    if (pathKey) {
      const count = perPathCount.get(pathKey) || 0;
      if (count >= params.maxPerPath) {
        overflow.push(item);
        continue;
      }
    }
    selectItem(item);
  }

  if (selected.length < params.topK) {
    for (const item of overflow) {
      if (selected.length >= params.topK) break;
      if (selectedIds.has(item.embedding.id)) continue;
      selectItem(item);
    }
  }

  if (selected.length < params.topK) {
    for (const item of params.scored) {
      if (selected.length >= params.topK) break;
      if (selectedIds.has(item.embedding.id)) continue;
      selectItem(item);
    }
  }

  return selected;
}

function applyRrfScores(
  scored: Array<{
    embedding: { id: number };
    semantic: number;
    lexical: number;
    rrf: number;
  }>
) {
  const rankDenominator = 50;
  const semanticRank = new Map<number, number>();
  const lexicalRank = new Map<number, number>();

  [...scored]
    .sort((a, b) => b.semantic - a.semantic)
    .forEach((item, idx) => {
      semanticRank.set(item.embedding.id, idx + 1);
    });
  [...scored]
    .sort((a, b) => b.lexical - a.lexical)
    .forEach((item, idx) => {
      lexicalRank.set(item.embedding.id, idx + 1);
    });

  for (const item of scored) {
    const semRank = semanticRank.get(item.embedding.id) || scored.length;
    const lexRank = lexicalRank.get(item.embedding.id) || scored.length;
    item.rrf = 1 / (rankDenominator + semRank) + 1 / (rankDenominator + lexRank);
  }
}

function normalizeCosine(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value + 1) / 2));
}

function buildLexicalInput(params: {
  path?: string;
  symbol?: string;
  text: string;
}): string {
  const pathParts = params.path
    ? `${params.path} ${params.path.replace(/[._\/-]+/g, " ")}`
    : "";
  const symbol = params.symbol || "";
  const text = params.text.slice(0, 2200);
  return `${pathParts} ${symbol} ${text}`;
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

function computePathBoost(params: {
  path: string;
  changedPaths: Set<string>;
  changedDirectories: Set<string>;
  queryPathHints: string[];
  changedPathBoost: number;
  sameDirectoryBoost: number;
}): number {
  const { path, changedPaths, changedDirectories, queryPathHints, changedPathBoost, sameDirectoryBoost } = params;
  let boost = 0;

  if (changedPaths.size > 0) {
    if (changedPaths.has(path)) {
      boost += changedPathBoost;
    } else if (changedDirectories.has(directoryPath(path))) {
      boost += sameDirectoryBoost;
    }
  }

  if (queryPathHints.length > 0) {
    for (const hint of queryPathHints) {
      if (path.includes(hint)) {
        boost += 0.04;
        break;
      }
    }
  }

  return boost;
}

function extractPathHints(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.trim().replace(/[^a-z0-9_./-]/g, ""))
        .filter((token) => token.includes("/") || token.includes("."))
        .filter((token) => token.length >= 3)
    )
  ).slice(0, 8);
}

function directoryPath(value: string): string {
  const idx = value.lastIndexOf("/");
  return idx === -1 ? "" : value.slice(0, idx);
}

function normalizeRepoPath(pathValue: string): string {
  let normalized = pathValue.trim().replace(/\\/g, "/").replace(/^\//, "");
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    normalized = normalized.slice(2);
  }
  return normalized.toLowerCase();
}
