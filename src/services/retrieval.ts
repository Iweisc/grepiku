import fs from "fs/promises";
import os from "os";
import path from "path";
import { execa } from "execa";
import { prisma } from "../db/client.js";
import { normalizePath } from "../review/diff.js";
import { cosineSimilarity, embedQueryWithCache } from "./embeddings.js";
import { shouldSkipSensitivePath } from "./indexerPathPolicy.js";

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
    vector: number;
    titleLexical: number;
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
const MIN_RETRIEVAL_CANDIDATES = 2000;
const MAX_RETRIEVAL_CANDIDATES = 12000;
const RETRIEVAL_CANDIDATES_PER_TOPK = 200;
const RETRIEVAL_CANDIDATE_TRIM_MULTIPLIER = 2;
const MAX_PAGEINDEX_INPUT_BYTES = 8 * 1024 * 1024;

type EmbeddingRow = {
  id: number;
  fileId: number | null;
  symbolId: number | null;
  kind: string;
  vector?: number[];
  text: string;
};

type ScoredRetrievalItem = {
  embedding: {
    id: number;
    fileId: number | null;
    symbolId: number | null;
    kind: string;
  };
  path?: string;
  symbol?: string;
  isPattern?: boolean;
  semantic: number;
  lexical: number;
  vectorScore: number;
  titleLexical: number;
  pathBoost: number;
  patternBoost: number;
  kindBoost: number;
  directoryAffinity: number;
  fileAnchor: number;
  rrf: number;
  baseScore: number;
  score: number;
};

type RankedRetrievalItem = {
  embedding: { id: number };
  path?: string;
  score: number;
};

type PageIndexScore = {
  score: number;
  semantic: number;
  lexical: number;
  pathBoost: number;
  kindBoost: number;
  patternBoost: number;
};

type PageIndexInputItem = {
  id: number;
  kind: RetrievalResult["kind"];
  path?: string;
  symbol?: string;
  text: string;
};

type EmbeddingBatchMetadata = {
  fileMap: Map<number, { path: string; isPattern: boolean }>;
  symbolMap: Map<number, string>;
};

export async function retrieveContext(params: {
  repoId: number;
  query: string;
  topK?: number;
  maxPerPath?: number;
  changedPaths?: string[];
  weights?: Partial<RetrievalWeights>;
}): Promise<RetrievalResult[]> {
  const topK = Math.max(4, Math.min(60, params.topK ?? 28));
  const maxPerPath = Math.max(1, Math.min(12, params.maxPerPath ?? 6));
  const weights = mergeWeights(params.weights);
  const changedPathList = Array.from(
    new Set(
      (params.changedPaths || [])
        .map((value) => normalizeRepoPath(value))
        .filter(Boolean)
    )
  );
  const changedPaths = new Set(changedPathList);
  const changedDirectories = new Set(
    Array.from(changedPaths)
      .map((value) => directoryPath(value))
      .filter(Boolean)
  );
  const queryTokens = tokenize(params.query);
  const queryPathHints = extractPathHints(params.query);
  const candidateLimit = computeRetrievalCandidateLimit(topK);
  const candidateTrimThreshold = candidateLimit * RETRIEVAL_CANDIDATE_TRIM_MULTIPLIER;
  let queryVector: number[] | null | undefined;
  const resolveQueryVector = async () => {
    if (queryVector !== undefined) return queryVector;
    try {
      queryVector = await embedQueryWithCache({ repoId: params.repoId, query: params.query });
    } catch (error) {
      console.warn("[retrieval] query embedding failed; falling back to lexical scoring", {
        repoId: params.repoId,
        error: error instanceof Error ? error.message : String(error)
      });
      queryVector = null;
    }
    return queryVector;
  };

  const scored: ScoredRetrievalItem[] = [];
  const sourceTextByEmbeddingId = new Map<number, string>();

  await forEachRepoEmbeddingBatch({
    repoId: params.repoId,
    includeVector: true,
    onBatch: async (batch) => {
      const { fileMap, symbolMap } = await loadEmbeddingBatchMetadata(params.repoId, batch);
      for (const embedding of batch) {
        const fileMeta = embedding.fileId ? fileMap.get(embedding.fileId) : undefined;
        const path = fileMeta?.path;
        if (path && shouldSkipSensitivePath(path)) {
          continue;
        }
        const symbol = embedding.symbolId ? symbolMap.get(embedding.symbolId) : undefined;
        const sourceText = embedding.text || "";
        const titleLexical = lexicalSimilarity(
          queryTokens,
          tokenize(buildNodeTitle({ path, symbol, text: sourceText }))
        );
        let vectorScore = 0;
        if (embedding.vector && embedding.vector.length > 0) {
          const vector = await resolveQueryVector();
          if (vector && vector.length > 0) {
            vectorScore = Math.max(0, cosineSimilarity(vector, embedding.vector));
          }
        }
        const semantic = vectorScore > 0 ? vectorScore : titleLexical;
        const lexical = lexicalSimilarity(
          queryTokens,
          tokenize(buildLexicalInput({ path, symbol, text: sourceText }))
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
        const item: ScoredRetrievalItem = {
          embedding: {
            id: embedding.id,
            fileId: embedding.fileId,
            symbolId: embedding.symbolId,
            kind: embedding.kind
          },
          path,
          symbol,
          isPattern: fileMeta?.isPattern,
          semantic,
          lexical,
          vectorScore,
          titleLexical,
          pathBoost,
          patternBoost,
          kindBoost,
          directoryAffinity: 0,
          fileAnchor: 0,
          rrf: 0,
          baseScore:
            semantic * weights.semanticWeight +
            lexical * weights.lexicalWeight +
            pathBoost +
            patternBoost +
            kindBoost,
          score: 0
        };
        scored.push(item);
        sourceTextByEmbeddingId.set(item.embedding.id, sourceText);
      }
      if (scored.length > candidateTrimThreshold) {
        trimRetrievalCandidates({
          candidates: scored,
          sourceTextByEmbeddingId,
          limit: candidateLimit
        });
      }
    }
  });

  if (scored.length > candidateLimit) {
    trimRetrievalCandidates({
      candidates: scored,
      sourceTextByEmbeddingId,
      limit: candidateLimit
    });
  }

  const pageIndexScores = await scoreWithPageIndex({
    query: params.query,
    topK,
    changedPaths: changedPathList,
    items: [...scored]
      .sort((left, right) => right.baseScore - left.baseScore)
      .map((item) => ({
        id: item.embedding.id,
        kind: mapEmbeddingKind(item.embedding.kind),
        path: item.path,
        symbol: item.symbol,
        text: sourceTextByEmbeddingId.get(item.embedding.id) || ""
      })),
  }).catch(() => new Map<number, PageIndexScore>());
  const pageIndexAvailable = pageIndexScores.size > 0;

  const anchorByPath = new Map<string, number>();
  for (const item of scored) {
    const scriptScore = pageIndexScores.get(item.embedding.id);
    const titleFallback = pageIndexAvailable ? (scriptScore?.semantic ?? item.titleLexical) : item.titleLexical;
    const lexicalFallback = item.lexical;
    item.titleLexical = titleFallback;
    item.semantic = item.vectorScore > 0 ? item.vectorScore : titleFallback;
    item.lexical = pageIndexAvailable ? (scriptScore?.lexical ?? lexicalFallback) : lexicalFallback;
    item.baseScore =
      item.semantic * weights.semanticWeight +
      item.lexical * weights.lexicalWeight +
      item.pathBoost +
      item.patternBoost +
      item.kindBoost;
    if (item.path) {
      const pathAnchor = item.semantic * 0.66 + item.lexical * 0.34 + item.pathBoost;
      anchorByPath.set(item.path, Math.max(anchorByPath.get(item.path) || 0, pathAnchor));
    }
  }

  applyRrfScores(scored);
  const directoryAnchors = buildDirectoryAnchors(anchorByPath, changedDirectories);

  for (const item of scored) {
    item.directoryAffinity = item.path
      ? computeDirectoryAffinity({
          path: item.path,
          changedDirectories,
          directoryAnchors,
          sameDirectoryBoost: weights.sameDirectoryBoost
        })
      : 0;
    const pathAnchor = item.path ? anchorByPath.get(item.path) || 0 : 0;
    item.fileAnchor =
      pathAnchor <= 0
        ? 0
        : Math.min(
            0.18,
            pathAnchor * (item.embedding.kind === "file" ? 0.07 : item.embedding.kind === "symbol" ? 0.15 : 0.12)
          );
    item.score = item.baseScore + item.rrf * weights.rrfWeight + item.directoryAffinity + item.fileAnchor;
  }

  scored.sort((a, b) => b.score - a.score);

  const selected = selectRankedRetrievalItems({
    scored,
    topK,
    maxPerPath,
    changedPaths
  });

  const selectedIds = selected.map((item) => item.embedding.id);
  const selectedRows =
    selectedIds.length > 0
      ? await prisma.embedding.findMany({
          where: { id: { in: selectedIds } },
          select: { id: true, text: true }
        })
      : [];
  const textByEmbeddingId = new Map<number, string>();
  for (const row of selectedRows) {
    textByEmbeddingId.set(row.id, row.text);
  }

  return selected.map((item) => ({
    kind: mapEmbeddingKind(item.embedding.kind),
    score: item.score,
    path: item.path,
    symbol: item.symbol,
    text: textByEmbeddingId.get(item.embedding.id) || "",
    isPattern: item.isPattern,
    signals: {
      semantic: item.semantic,
      lexical: item.lexical,
      vector: item.vectorScore,
      titleLexical: item.titleLexical,
      pathBoost: item.pathBoost,
      kindBoost: item.kindBoost,
      patternBoost: item.patternBoost,
      rrf: item.rrf
    }
  }));
}

async function loadEmbeddingBatchMetadata(
  repoId: number,
  batch: EmbeddingRow[]
): Promise<EmbeddingBatchMetadata> {
  const fileIds = Array.from(
    new Set(
      batch
        .map((row) => row.fileId)
        .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0)
    )
  );
  const symbolIds = Array.from(
    new Set(
      batch
        .map((row) => row.symbolId)
        .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0)
    )
  );

  const [files, symbols] = await Promise.all([
    fileIds.length > 0
      ? prisma.fileIndex.findMany({
          where: { repoId, id: { in: fileIds } },
          select: { id: true, path: true, isPattern: true }
        })
      : Promise.resolve([]),
    symbolIds.length > 0
      ? prisma.symbol.findMany({
          where: { repoId, id: { in: symbolIds } },
          select: { id: true, name: true }
        })
      : Promise.resolve([])
  ]);

  return {
    fileMap: new Map(
      files.map((file) => [
        file.id,
        {
          path: normalizeRepoPath(file.path),
          isPattern: file.isPattern
        }
      ])
    ),
    symbolMap: new Map(symbols.map((symbol) => [symbol.id, symbol.name]))
  };
}

function computeRetrievalCandidateLimit(topK: number): number {
  const requested = Math.max(0, Math.floor(topK)) * RETRIEVAL_CANDIDATES_PER_TOPK;
  return Math.max(
    MIN_RETRIEVAL_CANDIDATES,
    Math.min(MAX_RETRIEVAL_CANDIDATES, requested)
  );
}

function trimRetrievalCandidates(params: {
  candidates: ScoredRetrievalItem[];
  sourceTextByEmbeddingId: Map<number, string>;
  limit: number;
}): void {
  params.candidates.sort((a, b) => b.baseScore - a.baseScore);
  params.candidates.length = Math.min(params.candidates.length, params.limit);
  const keepIds = new Set(params.candidates.map((item) => item.embedding.id));
  for (const id of params.sourceTextByEmbeddingId.keys()) {
    if (!keepIds.has(id)) {
      params.sourceTextByEmbeddingId.delete(id);
    }
  }
}

async function scoreWithPageIndex(params: {
  query: string;
  topK: number;
  changedPaths: string[];
  items: PageIndexInputItem[];
}): Promise<Map<number, PageIndexScore>> {
  const projectRoot = (process.env.PROJECT_ROOT || process.cwd()).trim() || process.cwd();
  const scriptPath = path.join(projectRoot, "src", "scripts", "pageindex_retrieve.py");
  const pageindexRoot = path.join(projectRoot, "PageIndex");
  const output = new Map<number, PageIndexScore>();

  try {
    await fs.access(scriptPath);
    await fs.access(pageindexRoot);
  } catch {
    return output;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-pageindex-"));
  const inputPath = path.join(tempDir, "input.json");
  const limitedItems = limitPageIndexInputItems(params.items, MAX_PAGEINDEX_INPUT_BYTES);

  try {
    await fs.writeFile(
      inputPath,
      JSON.stringify(
        {
          query: params.query,
          top_k: params.topK,
          changed_paths: params.changedPaths,
          pageindex_root: pageindexRoot,
          items: limitedItems
        },
        null,
        2
      ),
      "utf8"
    );

    const { stdout } = await execa("python3", [scriptPath, "--input", inputPath], {
      cwd: projectRoot,
      reject: true
    });
    const raw = stdout.trim();
    if (!raw) return output;
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const candidate = lines[lines.length - 1] || raw;
    const parsed = JSON.parse(candidate) as {
      results?: Array<{
        id: number;
        score: number;
        semantic: number;
        lexical: number;
        pathBoost: number;
        kindBoost: number;
        patternBoost: number;
      }>;
    };
    for (const row of parsed.results || []) {
      if (!Number.isFinite(row?.id)) continue;
      output.set(Number(row.id), {
        score: Number(row.score) || 0,
        semantic: Number(row.semantic) || 0,
        lexical: Number(row.lexical) || 0,
        pathBoost: Number(row.pathBoost) || 0,
        kindBoost: Number(row.kindBoost) || 0,
        patternBoost: Number(row.patternBoost) || 0
      });
    }
    return output;
  } catch {
    return output;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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

function limitPageIndexInputItems(
  items: PageIndexInputItem[],
  maxBytes: number
): PageIndexInputItem[] {
  if (items.length === 0 || maxBytes <= 0) {
    return [];
  }

  const kept: PageIndexInputItem[] = [];
  let retainedBytes = 2;

  for (const item of items) {
    const serialized = JSON.stringify(item);
    const entryBytes = Buffer.byteLength(serialized, "utf8");
    const separatorBytes = kept.length > 0 ? 1 : 0;
    if (kept.length > 0 && retainedBytes + separatorBytes + entryBytes > maxBytes) {
      break;
    }
    kept.push(item);
    retainedBytes += separatorBytes + entryBytes;
  }

  return kept;
}

function sanitizeWeight(input: number | undefined, fallback: number): number {
  if (!Number.isFinite(input)) return fallback;
  if (!input || input < 0) return 0;
  return Math.min(input, 1);
}

async function forEachRepoEmbeddingBatch(params: {
  repoId: number;
  onBatch: (batch: EmbeddingRow[]) => Promise<void> | void;
  maxRows?: number;
  includeVector?: boolean;
}) {
  const maxRows = Number.isFinite(params.maxRows) ? Math.max(0, Number(params.maxRows)) : Number.POSITIVE_INFINITY;
  let cursor: number | null = null;
  let loadedRows = 0;
  const includeVector = Boolean(params.includeVector);

  while (loadedRows < maxRows) {
    const remaining = Number.isFinite(maxRows) ? Math.max(0, maxRows - loadedRows) : EMBEDDING_FETCH_BATCH;
    const take =
      Number.isFinite(maxRows) && maxRows !== Number.POSITIVE_INFINITY
        ? Math.min(EMBEDDING_FETCH_BATCH, remaining)
        : EMBEDDING_FETCH_BATCH;
    if (take <= 0) break;

    const batch = (await prisma.embedding.findMany({
      where: {
        repoId: params.repoId,
        kind: { in: ["file", "symbol", "chunk"] }
      },
      orderBy: { id: "desc" },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take,
      select: {
        id: true,
        fileId: true,
        symbolId: true,
        kind: true,
        text: true,
        ...(includeVector ? { vector: true } : {})
      }
    })) as EmbeddingRow[];

    if (batch.length === 0) break;
    loadedRows += batch.length;
    await params.onBatch(batch);
    if (batch.length < take) break;
    cursor = batch[batch.length - 1].id;
  }
}

export async function loadRepoEmbeddings(repoId: number, options?: { maxRows?: number }) {
  const rows: EmbeddingRow[] = [];
  await forEachRepoEmbeddingBatch({
    repoId,
    maxRows: options?.maxRows,
    includeVector: true,
    onBatch: (batch) => {
      rows.push(...batch);
    }
  });
  return rows;
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

function buildNodeTitle(params: { path?: string; symbol?: string; text: string }): string {
  const firstLine = params.text.split("\n", 1)[0] || "";
  return `${params.path || ""} ${params.symbol || ""} ${firstLine.slice(0, 180)}`.trim();
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
    const pathLower = path.toLowerCase();
    for (const hint of queryPathHints) {
      if (pathLower.includes(hint)) {
        boost += 0.04;
        break;
      }
    }
  }

  return boost;
}

function buildDirectoryAnchors(
  pathAnchors: Map<string, number>,
  changedDirectories: Set<string>
): Map<string, number> {
  const directoryAnchors = new Map<string, number>();

  const upsert = (dir: string, value: number) => {
    if (!dir) return;
    directoryAnchors.set(dir, Math.max(directoryAnchors.get(dir) || 0, value));
  };

  for (const [path, score] of pathAnchors.entries()) {
    let current = directoryPath(path);
    let decay = 1;
    while (current) {
      upsert(current, score * decay);
      const idx = current.lastIndexOf("/");
      if (idx < 0) break;
      current = current.slice(0, idx);
      decay *= 0.82;
    }
  }

  for (const dir of changedDirectories) {
    upsert(dir, 0.72);
    const idx = dir.lastIndexOf("/");
    if (idx > 0) {
      upsert(dir.slice(0, idx), 0.54);
    }
  }

  return directoryAnchors;
}

function computeDirectoryAffinity(params: {
  path: string;
  changedDirectories: Set<string>;
  directoryAnchors: Map<string, number>;
  sameDirectoryBoost: number;
}): number {
  const { path, changedDirectories, directoryAnchors, sameDirectoryBoost } = params;
  const dir = directoryPath(path);
  if (!dir) return 0;
  if (changedDirectories.has(dir)) return sameDirectoryBoost;

  const anchor = directoryAnchors.get(dir) || 0;
  if (anchor <= 0) return 0;
  return Math.min(sameDirectoryBoost, anchor * 0.12);
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
  return normalizePath(pathValue);
}

export const __retrievalInternals = {
  normalizeRepoPath
};
