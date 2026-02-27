import { prisma } from "../db/client.js";
import { retrieveContext } from "../services/retrieval.js";
import { normalizePath } from "./diff.js";
import type { RepoConfig } from "./config.js";

export type ContextPack = {
  query: string;
  retrieved: Array<{
    kind: "file" | "symbol" | "chunk";
    score: number;
    path?: string;
    symbol?: string;
    text: string;
    isPattern?: boolean;
  }>;
  relatedFiles: string[];
  changedFileStats: Array<{
    path: string;
    status?: string;
    additions?: number;
    deletions?: number;
    risk: "low" | "medium" | "high";
  }>;
  graphLinks: Array<{
    from: string;
    to: string;
    type: string;
  }>;
  graphPaths: Array<{
    path: string;
    score: number;
    via: string[];
  }>;
  graphDebug: {
    seedNodes: number;
    touchedSymbolSeeds: number;
    visitedNodes: number;
    traversedEdges: number;
    prunedByBudget: number;
    maxDepth: number;
    minScore: number;
    maxNodesVisited: number;
    traversalMs: number;
  };
  hotspots: Array<{
    path: string;
    openFindings: number;
    historicalFindings: number;
    topCategories: string[];
  }>;
  reviewFocus: string[];
};

type GraphNodeLite = {
  id: number;
  type: string;
  key: string;
  fileId: number | null;
  data?: unknown;
};

type GraphEdgeLite = {
  fromNodeId: number;
  toNodeId: number;
  type: string;
  data: unknown;
};

type TraversalParent = {
  fromNodeId: number;
  edgeType: string;
};

type GraphTraversalOptions = RepoConfig["graph"]["traversal"];

type GraphImpact = {
  rankedFiles: Array<{ path: string; graphScore: number; depth: number; via: string[] }>;
  linkCandidates: Array<{ from: string; to: string; type: string; score: number }>;
  debug: ContextPack["graphDebug"];
  options: GraphTraversalOptions;
};

const TRAVERSABLE_EDGE_TYPES = [
  "file_dep",
  "file_dep_inferred",
  "references_symbol",
  "contains_symbol",
  "class_contains_symbol",
  "symbol_contains_symbol",
  "symbol_imports_file",
  "exports_symbol",
  "dir_contains_file",
  "dir_contains_dir",
  "module_contains",
  "module_dep"
] as const;

const STRONG_EDGE_TYPES = new Set([
  "file_dep",
  "module_dep",
  "symbol_imports_file",
  "exports_symbol",
  "references_symbol"
]);

const DIRECTORY_EDGE_TYPES = new Set(["dir_contains_file", "dir_contains_dir"]);
const MODULE_EDGE_TYPES = new Set(["module_contains"]);

const GLOBAL_EDGE_BUDGET_BASE: Record<string, number> = {
  file_dep: 880,
  file_dep_inferred: 640,
  references_symbol: 780,
  contains_symbol: 520,
  class_contains_symbol: 280,
  symbol_contains_symbol: 280,
  symbol_imports_file: 640,
  exports_symbol: 520,
  dir_contains_file: 140,
  dir_contains_dir: 120,
  module_contains: 120,
  module_dep: 220
};

const DEFAULT_TRAVERSAL_OPTIONS: GraphTraversalOptions = {
  max_depth: 5,
  min_score: 0.07,
  max_related_files: 28,
  max_graph_links: 110,
  hard_include_files: 8,
  max_nodes_visited: 2600
};

function edgeWeightFromData(data: unknown): number {
  if (!data || typeof data !== "object" || Array.isArray(data)) return 1;
  const value = (data as Record<string, unknown>).weight;
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, value);
}

function traversalMultiplier(edgeType: string, direction: "out" | "in"): number | null {
  switch (edgeType) {
    case "file_dep":
      return direction === "in" ? 0.88 : 0.74;
    case "file_dep_inferred":
      return direction === "in" ? 0.78 : 0.61;
    case "references_symbol":
      return direction === "in" ? 0.72 : 0.82;
    case "contains_symbol":
      return direction === "in" ? 0.46 : 0.72;
    case "class_contains_symbol":
    case "symbol_contains_symbol":
      return direction === "in" ? 0.52 : 0.68;
    case "symbol_imports_file":
      return direction === "in" ? 0.62 : 0.78;
    case "exports_symbol":
      return direction === "in" ? 0.54 : 0.68;
    case "dir_contains_file":
      return 0.32;
    case "dir_contains_dir":
      return 0.28;
    case "module_contains":
      return 0.28;
    case "module_dep":
      return direction === "in" ? 0.62 : 0.52;
    default:
      return null;
  }
}

function resolveTraversalOptions(config: RepoConfig["graph"]["traversal"] | undefined): GraphTraversalOptions {
  return {
    max_depth: config?.max_depth ?? DEFAULT_TRAVERSAL_OPTIONS.max_depth,
    min_score: config?.min_score ?? DEFAULT_TRAVERSAL_OPTIONS.min_score,
    max_related_files: config?.max_related_files ?? DEFAULT_TRAVERSAL_OPTIONS.max_related_files,
    max_graph_links: config?.max_graph_links ?? DEFAULT_TRAVERSAL_OPTIONS.max_graph_links,
    hard_include_files: config?.hard_include_files ?? DEFAULT_TRAVERSAL_OPTIONS.hard_include_files,
    max_nodes_visited: config?.max_nodes_visited ?? DEFAULT_TRAVERSAL_OPTIONS.max_nodes_visited
  };
}

function localEdgeFanout(edgeType: string): number {
  if (STRONG_EDGE_TYPES.has(edgeType)) return 8;
  if (DIRECTORY_EDGE_TYPES.has(edgeType) || MODULE_EDGE_TYPES.has(edgeType)) return 2;
  return 4;
}

function globalEdgeBudget(edgeType: string, maxNodesVisited: number): number {
  const base = GLOBAL_EDGE_BUDGET_BASE[edgeType] ?? 400;
  const scale = Math.max(0.5, Math.min(4, maxNodesVisited / 2400));
  return Math.max(80, Math.round(base * scale));
}

function canTraverseDirection(edgeType: string, direction: "out" | "in"): boolean {
  if (DIRECTORY_EDGE_TYPES.has(edgeType) || MODULE_EDGE_TYPES.has(edgeType)) {
    return direction === "out";
  }
  if (
    edgeType === "contains_symbol" ||
    edgeType === "class_contains_symbol" ||
    edgeType === "symbol_contains_symbol"
  ) {
    return direction === "out";
  }
  return true;
}

function normalizeGraphPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function normalizeExcludeDirPrefix(value: string): string {
  return normalizeGraphPath(value).replace(/\/+$/, "");
}

function isExcludedGraphPath(filePath: string, excludePrefixes: string[]): boolean {
  const normalized = normalizeGraphPath(filePath);
  for (const prefix of excludePrefixes) {
    if (!prefix) continue;
    if (normalized === prefix) return true;
    if (normalized.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function buildDirectoryChain(filePath: string): string[] {
  const normalized = normalizeGraphPath(filePath);
  const segments = normalized.split("/");
  let current = "";
  const dirs = ["."];
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = current ? `${current}/${segments[i]}` : segments[i];
    dirs.push(current);
  }
  return dirs;
}

function parseChangedLinesByPath(diffPatch: string): Map<string, Set<number>> {
  const byPath = new Map<string, Set<number>>();
  const lines = diffPatch.split("\n");
  let currentPath = "";
  let inHunk = false;
  let newLine = 0;

  const addLine = (path: string, lineNo: number) => {
    if (!path || !Number.isFinite(lineNo) || lineNo <= 0) return;
    const set = byPath.get(path) || new Set<number>();
    set.add(lineNo);
    byPath.set(path, set);
  };

  for (const rawLine of lines) {
    if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      if (!target || target === "/dev/null") {
        currentPath = "";
        inHunk = false;
        continue;
      }
      const normalized = normalizePath(target.replace(/^b\//, ""));
      currentPath = normalized;
      inHunk = false;
      continue;
    }

    if (rawLine.startsWith("@@ ")) {
      const match = rawLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (!match) {
        inHunk = false;
        continue;
      }
      newLine = Number(match[1]);
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentPath) continue;
    if (rawLine.startsWith("\\ No newline at end of file")) continue;

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      addLine(currentPath, newLine);
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      addLine(currentPath, Math.max(1, newLine));
      continue;
    }

    if (rawLine.startsWith(" ")) {
      newLine += 1;
      continue;
    }
  }

  return byPath;
}

function parseSymbolRange(data: unknown): { startLine: number; endLine: number } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const startLine = Number((data as Record<string, unknown>).startLine);
  const endLine = Number((data as Record<string, unknown>).endLine);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null;
  if (startLine <= 0 || endLine < startLine) return null;
  return { startLine, endLine };
}

function intersectsLines(range: { startLine: number; endLine: number }, lines: Set<number>): boolean {
  for (const line of lines) {
    if (line >= range.startLine && line <= range.endLine) return true;
  }
  return false;
}

function nodeLabel(node: GraphNodeLite | undefined): string {
  if (!node) return "unknown";
  if (node.type === "directory") return node.key.replace(/^dir:/, "");
  if (node.type === "module") return node.key.replace(/^module:/, "module:");
  if (node.type === "symbol") {
    const [filePath, symbolName, startLine] = node.key.split(":");
    if (filePath && symbolName) {
      return `${filePath}::${symbolName}${startLine ? `@${startLine}` : ""}`;
    }
  }
  return node.key;
}

function popBestFrontier(frontier: Array<{ nodeId: number; score: number; depth: number }>) {
  if (frontier.length <= 1) return frontier.pop() || null;
  let bestIndex = 0;
  for (let i = 1; i < frontier.length; i += 1) {
    if (frontier[i].score > frontier[bestIndex].score) bestIndex = i;
  }
  const [best] = frontier.splice(bestIndex, 1);
  return best;
}

function buildProvenanceTrace(params: {
  targetNodeId: number;
  parentByNode: Map<number, TraversalParent>;
  nodeById: Map<number, GraphNodeLite>;
  maxSteps?: number;
}): string[] {
  const maxSteps = params.maxSteps ?? 8;
  const reversed: Array<{ fromNodeId: number; toNodeId: number; edgeType: string }> = [];
  const seen = new Set<number>();
  let cursor = params.targetNodeId;

  for (let step = 0; step < maxSteps; step += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const parent = params.parentByNode.get(cursor);
    if (!parent) break;
    reversed.push({ fromNodeId: parent.fromNodeId, toNodeId: cursor, edgeType: parent.edgeType });
    cursor = parent.fromNodeId;
  }

  return reversed
    .reverse()
    .map(
      (entry) =>
        `${nodeLabel(params.nodeById.get(entry.fromNodeId))} --${entry.edgeType}--> ${nodeLabel(
          params.nodeById.get(entry.toNodeId)
        )}`
    );
}

async function collectGraphImpact(params: {
  repoId: number;
  changedPaths: string[];
  diffPatch: string;
  traversal?: RepoConfig["graph"]["traversal"];
  excludeDirs?: string[];
}): Promise<GraphImpact> {
  const options = resolveTraversalOptions(params.traversal);
  const excludePrefixes = (params.excludeDirs || []).map(normalizeExcludeDirPrefix).filter(Boolean);
  const changedPathsForTraversal = params.changedPaths.filter(
    (filePath) => !isExcludedGraphPath(filePath, excludePrefixes)
  );

  if (changedPathsForTraversal.length === 0) {
    return {
      rankedFiles: [],
      linkCandidates: [],
      debug: {
        seedNodes: 0,
        touchedSymbolSeeds: 0,
        visitedNodes: 0,
        traversedEdges: 0,
        prunedByBudget: 0,
        maxDepth: options.max_depth,
        minScore: options.min_score,
        maxNodesVisited: options.max_nodes_visited,
        traversalMs: 0
      },
      options
    };
  }

  const [nodes, edges] = await Promise.all([
    prisma.graphNode.findMany({
      where: { repoId: params.repoId, type: { in: ["file", "symbol", "directory", "module"] } },
      select: { id: true, type: true, key: true, fileId: true, data: true }
    }),
    prisma.graphEdge.findMany({
      where: { repoId: params.repoId, type: { in: [...TRAVERSABLE_EDGE_TYPES] } },
      select: { fromNodeId: true, toNodeId: true, type: true, data: true }
    })
  ]);

  if (nodes.length === 0 || edges.length === 0) {
    return {
      rankedFiles: [],
      linkCandidates: [],
      debug: {
        seedNodes: 0,
        touchedSymbolSeeds: 0,
        visitedNodes: 0,
        traversedEdges: 0,
        prunedByBudget: 0,
        maxDepth: options.max_depth,
        minScore: options.min_score,
        maxNodesVisited: options.max_nodes_visited,
        traversalMs: 0
      },
      options
    };
  }

  const nodeById = new Map<number, GraphNodeLite>();
  const fileNodeIdByPath = new Map<string, number>();
  const symbolRangesByFileId = new Map<number, Array<{ nodeId: number; startLine: number; endLine: number }>>();
  const directoryNodeIdByPath = new Map<string, number>();

  for (const node of nodes) {
    nodeById.set(node.id, node);
    if (node.type === "file") {
      fileNodeIdByPath.set(node.key, node.id);
      continue;
    }
    if (node.type === "directory") {
      directoryNodeIdByPath.set(node.key.replace(/^dir:/, ""), node.id);
      continue;
    }
    if (node.type !== "symbol" || !node.fileId) continue;
    const range = parseSymbolRange(node.data);
    if (!range) continue;
    const list = symbolRangesByFileId.get(node.fileId) || [];
    list.push({ nodeId: node.id, startLine: range.startLine, endLine: range.endLine });
    symbolRangesByFileId.set(node.fileId, list);
  }

  const changedFileNodeIds = changedPathsForTraversal
    .map((filePath) => fileNodeIdByPath.get(filePath) || null)
    .filter((value): value is number => value !== null);
  if (changedFileNodeIds.length === 0) {
    return {
      rankedFiles: [],
      linkCandidates: [],
      debug: {
        seedNodes: 0,
        touchedSymbolSeeds: 0,
        visitedNodes: 0,
        traversedEdges: 0,
        prunedByBudget: 0,
        maxDepth: options.max_depth,
        minScore: options.min_score,
        maxNodesVisited: options.max_nodes_visited,
        traversalMs: 0
      },
      options
    };
  }

  const changedLinesByPath = parseChangedLinesByPath(params.diffPatch);
  const startNodeIds = new Set<number>(changedFileNodeIds);
  let touchedSymbolSeeds = 0;

  const addSeed = (nodeId: number) => {
    if (startNodeIds.has(nodeId)) return false;
    startNodeIds.add(nodeId);
    return true;
  };

  for (const fileNodeId of changedFileNodeIds) {
    const fileNode = nodeById.get(fileNodeId);
    if (!fileNode?.fileId) continue;

    const lineSet = changedLinesByPath.get(fileNode.key);
    const ranges = symbolRangesByFileId.get(fileNode.fileId) || [];

    let seededInFile = 0;
    if (lineSet && lineSet.size > 0) {
      for (const range of ranges) {
        if (!intersectsLines(range, lineSet)) continue;
        if (addSeed(range.nodeId)) {
          touchedSymbolSeeds += 1;
          seededInFile += 1;
        }
      }
    }

    if (seededInFile === 0) {
      const fallback = [...ranges]
        .sort((a, b) => a.startLine - b.startLine)
        .slice(0, 2);
      for (const range of fallback) {
        if (addSeed(range.nodeId)) touchedSymbolSeeds += 1;
      }
    }

    for (const dir of buildDirectoryChain(fileNode.key)) {
      const dirNodeId = directoryNodeIdByPath.get(dir);
      if (dirNodeId) addSeed(dirNodeId);
    }
  }

  const outgoing = new Map<number, GraphEdgeLite[]>();
  const incoming = new Map<number, GraphEdgeLite[]>();
  const changedFileNodeIdSet = new Set(changedFileNodeIds);
  for (const edge of edges) {
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId)) continue;
    const outList = outgoing.get(edge.fromNodeId) || [];
    outList.push(edge);
    outgoing.set(edge.fromNodeId, outList);

    const inList = incoming.get(edge.toNodeId) || [];
    inList.push(edge);
    incoming.set(edge.toNodeId, inList);

    if (edge.type !== "module_contains" || !changedFileNodeIdSet.has(edge.toNodeId)) continue;
    const fromNode = nodeById.get(edge.fromNodeId);
    if (fromNode?.type === "module") addSeed(edge.fromNodeId);
  }

  const minScore = options.min_score;
  const bestScore = new Map<number, number>();
  const bestDepth = new Map<number, number>();
  const parentByNode = new Map<number, TraversalParent>();
  const frontier: Array<{ nodeId: number; score: number; depth: number }> = [];
  for (const nodeId of startNodeIds) {
    bestScore.set(nodeId, 1);
    bestDepth.set(nodeId, 0);
    frontier.push({ nodeId, score: 1, depth: 0 });
  }

  const edgeVisitsByType = new Map<string, number>();
  let visitedNodes = 0;
  let traversedEdges = 0;
  let prunedByBudget = 0;

  while (frontier.length > 0 && visitedNodes < options.max_nodes_visited) {
    const current = popBestFrontier(frontier);
    if (!current) break;
    visitedNodes += 1;
    if (current.depth >= options.max_depth) continue;

    const candidates: Array<{
      edge: GraphEdgeLite;
      nextNodeId: number;
      nextDepth: number;
      nextScore: number;
      rankScore: number;
    }> = [];

    const collectCandidate = (edge: GraphEdgeLite, direction: "out" | "in") => {
      if (!canTraverseDirection(edge.type, direction)) return;
      const multiplier = traversalMultiplier(edge.type, direction);
      if (!multiplier) return;
      const weight = edgeWeightFromData(edge.data);
      const weightBoost = Math.min(1.28, 1 + Math.log10(weight) * 0.22);
      const nextNodeId = direction === "out" ? edge.toNodeId : edge.fromNodeId;
      const nextDepth = current.depth + 1;
      const nextScore = current.score * multiplier * weightBoost;
      if (nextScore < minScore) return;
      const nextNode = nodeById.get(nextNodeId);
      const nodeBias =
        nextNode?.type === "file" ? 1.08 : nextNode?.type === "symbol" ? 0.95 : nextNode?.type === "module" ? 0.86 : 0.8;
      candidates.push({
        edge,
        nextNodeId,
        nextDepth,
        nextScore,
        rankScore: nextScore * (direction === "out" ? 1 : 0.98) * nodeBias
      });
    };

    for (const edge of outgoing.get(current.nodeId) || []) collectCandidate(edge, "out");
    for (const edge of incoming.get(current.nodeId) || []) collectCandidate(edge, "in");

    candidates.sort((a, b) => b.rankScore - a.rankScore);

    const localByType = new Map<string, number>();
    for (const candidate of candidates) {
      const type = candidate.edge.type;
      const localCount = localByType.get(type) || 0;
      if (localCount >= localEdgeFanout(type)) {
        prunedByBudget += 1;
        continue;
      }

      const globalCount = edgeVisitsByType.get(type) || 0;
      const globalCap = globalEdgeBudget(type, options.max_nodes_visited);
      if (globalCount >= globalCap) {
        prunedByBudget += 1;
        continue;
      }

      localByType.set(type, localCount + 1);
      edgeVisitsByType.set(type, globalCount + 1);
      traversedEdges += 1;

      const prevScore = bestScore.get(candidate.nextNodeId) || 0;
      const prevDepth = bestDepth.get(candidate.nextNodeId) ?? Number.POSITIVE_INFINITY;
      const improvedScore = candidate.nextScore > prevScore * 1.05;
      const improvedDepth = candidate.nextDepth < prevDepth;
      if (!improvedScore && !improvedDepth) continue;

      bestScore.set(candidate.nextNodeId, Math.max(prevScore, candidate.nextScore));
      bestDepth.set(candidate.nextNodeId, Math.min(prevDepth, candidate.nextDepth));
      parentByNode.set(candidate.nextNodeId, {
        fromNodeId: current.nodeId,
        edgeType: type
      });

      frontier.push({
        nodeId: candidate.nextNodeId,
        score: candidate.nextScore,
        depth: candidate.nextDepth
      });
    }
  }

  const changedPathSet = new Set(changedPathsForTraversal);
  const rankedFiles = Array.from(bestScore.entries())
    .map(([nodeId, graphScore]) => {
      const node = nodeById.get(nodeId);
      if (!node || node.type !== "file") return null;
      if (isExcludedGraphPath(node.key, excludePrefixes)) return null;
      if (changedPathSet.has(node.key)) return null;
      return {
        path: node.key,
        graphScore,
        depth: bestDepth.get(nodeId) ?? options.max_depth,
        via: buildProvenanceTrace({ targetNodeId: nodeId, parentByNode, nodeById })
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => b.graphScore - a.graphScore)
    .slice(0, Math.max(options.max_related_files * 4, options.max_related_files));

  const graphLinkByKey = new Map<string, { from: string; to: string; type: string; score: number }>();
  for (const edge of edges) {
    if (!edge.type.startsWith("file_dep")) continue;
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    if (!from || !to || from.type !== "file" || to.type !== "file") continue;
    if (isExcludedGraphPath(from.key, excludePrefixes) || isExcludedGraphPath(to.key, excludePrefixes)) {
      continue;
    }
    const fromScore = bestScore.get(from.id) || 0;
    const toScore = bestScore.get(to.id) || 0;
    if (fromScore <= 0 && toScore <= 0 && !changedPathSet.has(from.key) && !changedPathSet.has(to.key)) {
      continue;
    }
    const score =
      fromScore +
      toScore +
      edgeWeightFromData(edge.data) * 0.05 +
      (edge.type === "file_dep" ? 0.05 : 0);
    const dedupeKey = `${from.key}|${to.key}|${edge.type}`;
    const existing = graphLinkByKey.get(dedupeKey);
    if (!existing || score > existing.score) {
      graphLinkByKey.set(dedupeKey, { from: from.key, to: to.key, type: edge.type, score });
    }
  }

  const linkCandidates = Array.from(graphLinkByKey.values()).sort((a, b) => b.score - a.score);

  return {
    rankedFiles,
    linkCandidates,
    debug: {
      seedNodes: startNodeIds.size,
      touchedSymbolSeeds,
      visitedNodes,
      traversedEdges,
      prunedByBudget,
      maxDepth: options.max_depth,
      minScore: options.min_score,
      maxNodesVisited: options.max_nodes_visited,
      traversalMs: 0
    },
    options
  };
}

export async function buildContextPack(params: {
  repoId: number;
  diffPatch: string;
  changedFiles: Array<{
    filename?: string;
    path?: string;
    status?: string;
    additions?: number;
    deletions?: number;
  }>;
  topK?: number;
  retrieval?: RepoConfig["retrieval"];
  graph?: RepoConfig["graph"];
  prTitle?: string | null;
  prBody?: string | null;
}): Promise<ContextPack> {
  const changedFileStats = params.changedFiles
    .map((file) => {
      const rawPath = file.filename || file.path || "";
      const path = normalizePath(rawPath);
      if (!path) return null;
      const additions = typeof file.additions === "number" ? file.additions : undefined;
      const deletions = typeof file.deletions === "number" ? file.deletions : undefined;
      const churn = (additions || 0) + (deletions || 0);
      const risk: "low" | "medium" | "high" =
        churn >= 250 ? "high" : churn >= 80 ? "medium" : "low";
      return {
        path,
        status: file.status,
        additions,
        deletions,
        risk
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  const changedPaths = changedFileStats.map((file) => file.path);
  const diffSignals = buildDiffSignalSnippet(params.diffPatch);
  const queryParts = [
    params.prTitle ? `PR title: ${params.prTitle}` : "",
    params.prBody ? `PR body:\n${params.prBody.slice(0, 1200)}` : "",
    `Changed files:\n${changedPaths.join("\n")}`,
    `Diff signal lines:\n${diffSignals}`
  ].filter(Boolean);
  const query = queryParts.join("\n\n");

  const retrieved = await retrieveContext({
    repoId: params.repoId,
    query,
    topK: params.retrieval?.topK ?? params.topK ?? 18,
    maxPerPath: params.retrieval?.maxPerPath,
    changedPaths,
    weights: params.retrieval
  });

  const graphStart = Date.now();
  const graphImpact = await collectGraphImpact({
    repoId: params.repoId,
    changedPaths,
    diffPatch: params.diffPatch,
    traversal: params.graph?.traversal,
    excludeDirs: params.graph?.exclude_dirs
  });
  graphImpact.debug.traversalMs = Date.now() - graphStart;

  const changedPathSet = new Set(changedPaths);
  const graphScoreByPath = new Map<string, number>();
  const graphDepthByPath = new Map<string, number>();
  const graphViaByPath = new Map<string, string[]>();
  for (const item of graphImpact.rankedFiles) {
    graphScoreByPath.set(item.path, Math.max(graphScoreByPath.get(item.path) || 0, item.graphScore));
    graphDepthByPath.set(item.path, Math.min(graphDepthByPath.get(item.path) ?? Number.POSITIVE_INFINITY, item.depth));
    if (!graphViaByPath.has(item.path) || (item.via.length > 0 && (graphViaByPath.get(item.path) || []).length === 0)) {
      graphViaByPath.set(item.path, item.via);
    }
  }

  const retrievalScoreByPath = new Map<string, number>();
  for (const item of retrieved) {
    if (!item.path || changedPathSet.has(item.path)) continue;
    retrievalScoreByPath.set(item.path, Math.max(retrievalScoreByPath.get(item.path) || 0, item.score || 0));
  }

  const maxRetrievalScore = Math.max(0.0001, ...retrievalScoreByPath.values());
  const changedDirPrefixes = Array.from(
    new Set(
      changedPaths
        .map((value) => {
          const idx = value.lastIndexOf("/");
          return idx >= 0 ? value.slice(0, idx + 1) : "";
        })
        .filter(Boolean)
    )
  );

  const sharesChangedDir = (candidatePath: string) => {
    if (changedDirPrefixes.length === 0) return false;
    const idx = candidatePath.lastIndexOf("/");
    if (idx < 0) return false;
    const candidateDir = candidatePath.slice(0, idx + 1);
    for (const prefix of changedDirPrefixes) {
      if (candidateDir === prefix) return true;
      if (candidateDir.startsWith(prefix) || prefix.startsWith(candidateDir)) return true;
    }
    return false;
  };

  const candidatePaths = Array.from(
    new Set([
      ...graphImpact.rankedFiles.map((item) => item.path),
      ...retrievalScoreByPath.keys()
    ])
  );

  const hotspotCandidates = Array.from(new Set([...changedPaths, ...candidatePaths])).slice(0, 120);
  const historicalFindings =
    hotspotCandidates.length > 0
      ? await prisma.finding.findMany({
          where: {
            path: { in: hotspotCandidates },
            pullRequest: { repoId: params.repoId }
          },
          select: { path: true, status: true, category: true }
        })
      : [];

  const hotspotMap = new Map<
    string,
    { openFindings: number; historicalFindings: number; byCategory: Map<string, number> }
  >();
  for (const finding of historicalFindings) {
    const existing =
      hotspotMap.get(finding.path) || {
        openFindings: 0,
        historicalFindings: 0,
        byCategory: new Map<string, number>()
      };
    existing.historicalFindings += 1;
    if (finding.status === "open") existing.openFindings += 1;
    existing.byCategory.set(finding.category, (existing.byCategory.get(finding.category) || 0) + 1);
    hotspotMap.set(finding.path, existing);
  }

  const maxRelatedFiles =
    changedPaths.length <= 2
      ? Math.min(graphImpact.options.max_related_files, 20)
      : changedPaths.length <= 5
        ? Math.min(graphImpact.options.max_related_files, 24)
        : graphImpact.options.max_related_files;
  const hardIncludeBudget = Math.min(
    graphImpact.options.hard_include_files,
    Math.max(2, Math.floor(maxRelatedFiles / 3))
  );
  const hardIncludePreferred = graphImpact.rankedFiles
    .filter((item) => !changedPathSet.has(item.path))
    .filter((item) => item.depth <= 2 || item.graphScore >= 0.42)
    .map((item) => item.path);
  const hardIncludeFallback = graphImpact.rankedFiles
    .filter((item) => !changedPathSet.has(item.path))
    .map((item) => item.path);
  const hardInclude = Array.from(new Set([...hardIncludePreferred, ...hardIncludeFallback])).slice(
    0,
    hardIncludeBudget
  );

  const combinedRanked = candidatePaths
    .filter((path) => !changedPathSet.has(path))
    .map((path) => {
      const graphScore = graphScoreByPath.get(path) || 0;
      const graphDepth = graphDepthByPath.get(path) ?? graphImpact.options.max_depth + 1;
      const retrievalRaw = retrievalScoreByPath.get(path) || 0;
      const retrievalScore = retrievalRaw / maxRetrievalScore;
      const hotspot = hotspotMap.get(path);
      const hotspotBonus = hotspot
        ? Math.min(0.2, hotspot.openFindings * 0.04 + hotspot.historicalFindings * 0.008)
        : 0;
      const sameDirBonus = sharesChangedDir(path) ? 0.06 : 0;
      const depthBonus =
        graphScore <= 0
          ? 0
          : graphDepth <= 1
            ? 0.08
            : graphDepth === 2
              ? 0.04
              : graphDepth === 3
                ? 0
                : -Math.min(0.16, (graphDepth - 3) * 0.06);

      const graphOnly = retrievalRaw <= 0;
      if (graphOnly && graphDepth > 4) return null;
      if (graphOnly && graphScore < 0.16 && hotspotBonus < 0.03) return null;

      const combinedScore = graphScore * 0.46 + retrievalScore * 0.4 + hotspotBonus + sameDirBonus + depthBonus;
      if (combinedScore < 0.045) return null;
      return { path, combinedScore };
    })
    .filter((item): item is { path: string; combinedScore: number } => Boolean(item))
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .map((item) => item.path);

  const relatedFiles = Array.from(new Set([...hardInclude, ...combinedRanked])).slice(
    0,
    maxRelatedFiles
  );

  const includedPathSet = new Set([...changedPaths, ...relatedFiles]);
  const graphLinks = graphImpact.linkCandidates
    .filter((link) => includedPathSet.has(link.from) && includedPathSet.has(link.to))
    .slice(0, graphImpact.options.max_graph_links)
    .map((item) => ({ from: item.from, to: item.to, type: item.type }));

  const relatedSet = new Set(relatedFiles);
  const graphPaths = graphImpact.rankedFiles
    .filter((item) => relatedSet.has(item.path))
    .slice(0, 12)
    .map((item) => ({
      path: item.path,
      score: item.graphScore,
      via: graphViaByPath.get(item.path) || item.via
    }));

  const hotspotRelevant = new Set([...changedPaths, ...relatedFiles, ...hardInclude]);
  const hotspots = Array.from(hotspotMap.entries())
    .filter(([path]) => hotspotRelevant.has(path))
    .map(([path, value]) => ({
      path,
      openFindings: value.openFindings,
      historicalFindings: value.historicalFindings,
      topCategories: Array.from(value.byCategory.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([category]) => category)
    }))
    .sort((a, b) => {
      if (b.openFindings !== a.openFindings) return b.openFindings - a.openFindings;
      return b.historicalFindings - a.historicalFindings;
    })
    .slice(0, 8);

  const reviewFocus = buildFocusHints({
    changedFileStats,
    hotspots,
    graphLinks,
    graphPaths
  });

  return {
    query,
    retrieved,
    relatedFiles,
    changedFileStats,
    graphLinks,
    graphPaths,
    graphDebug: graphImpact.debug,
    hotspots,
    reviewFocus
  };
}

function buildDiffSignalSnippet(diffPatch: string): string {
  const lines = diffPatch.split("\n");
  const signalLines = lines
    .filter(
      (line) =>
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---")
    )
    .slice(0, 140);
  return signalLines.join("\n").slice(0, 6000);
}

function buildFocusHints(params: {
  changedFileStats: ContextPack["changedFileStats"];
  hotspots: ContextPack["hotspots"];
  graphLinks: ContextPack["graphLinks"];
  graphPaths: ContextPack["graphPaths"];
}): string[] {
  const hints: string[] = [];
  for (const file of params.changedFileStats.slice(0, 8)) {
    if (file.risk === "high") {
      hints.push(`High churn changed file: ${file.path} (prioritize correctness and regressions).`);
    } else if (file.risk === "medium") {
      hints.push(`Medium churn changed file: ${file.path} (check edge cases and tests).`);
    }
  }
  for (const hotspot of params.hotspots.slice(0, 5)) {
    if (hotspot.openFindings <= 0) continue;
    hints.push(
      `Historical hotspot: ${hotspot.path} has ${hotspot.openFindings} open finding(s) in categories ${hotspot.topCategories.join(
        ", "
      ) || "unknown"}.`
    );
  }
  for (const link of params.graphLinks.slice(0, 10)) {
    if (link.type !== "file_dep" && link.type !== "file_dep_inferred") continue;
    hints.push(`Cross-file dependency: ${link.from} depends on ${link.to}.`);
  }
  for (const item of params.graphPaths.slice(0, 4)) {
    if (!item.via || item.via.length === 0) continue;
    hints.push(`Traversal path to ${item.path}: ${item.via[0]}.`);
  }
  return Array.from(new Set(hints)).slice(0, 14);
}

export const __contextInternals = {
  parseChangedLinesByPath,
  localEdgeFanout,
  globalEdgeBudget,
  buildProvenanceTrace
};
