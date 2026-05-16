import type { RepoConfig } from "./config.js";
import { normalizePath } from "./diff.js";
import type { ReviewDiffChunk } from "./diffChunks.js";
import type { ContextPack } from "./context.js";
import { isStatefulReviewPath } from "./risk.js";

const CHUNK_RETRIEVAL_TOP_K = 16;
const CHUNK_RETRIEVAL_MAX_PER_PATH = 3;
const CHUNK_GRAPH_MAX_DEPTH = 4;
const CHUNK_GRAPH_MAX_RELATED_FILES = 16;
const CHUNK_GRAPH_MAX_LINKS = 48;
const CHUNK_GRAPH_HARD_INCLUDE_FILES = 4;
const CHUNK_GRAPH_MAX_NODES = 1400;
const CHUNK_CONTEXT_MAX_CHANGED_STATS = 80;
const HIGH_IMPACT_HOTSPOT_CATEGORIES = new Set(["bug", "security", "performance"]);
const RISK_SCORE: Record<ContextPack["changedFileStats"][number]["risk"], number> = {
  low: 1,
  medium: 2,
  high: 3
};

function modulePrefix(filePath: string): string {
  const parts = normalizePath(filePath).split("/").filter(Boolean);
  if (parts.length === 0) return "";
  if ((parts[0] === "apps" || parts[0] === "packages") && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function chunkPathSet(chunk: ReviewDiffChunk): Set<string> {
  return new Set(chunk.paths.map((filePath) => normalizePath(filePath)));
}

function compactPathList(paths: string[], limit: number): string {
  const shown = paths.slice(0, limit).join(", ");
  return paths.length > limit ? `${shown}, ...` : shown;
}

function buildChunkFocus(params: {
  chunk: ReviewDiffChunk;
  changedFileStats: ContextPack["changedFileStats"];
  hotspots: ContextPack["hotspots"];
  graphLinks: ContextPack["graphLinks"];
  graphPaths: ContextPack["graphPaths"];
}): string[] {
  const hints = [
    `Review ${params.chunk.id} only: ${compactPathList(params.chunk.paths, 24)}`
  ];
  for (const file of params.changedFileStats.slice(0, 8)) {
    const normalizedPath = normalizePath(file.path).toLowerCase();
    if (/\/thread_controller\.(go|ts|tsx|js|jsx)$/.test(normalizedPath)) {
      hints.push(
        `High-risk changed file: ${file.path} (verify every thread read/update/delete is scoped by authenticated user_id as well as session/thread ids).`
      );
      continue;
    }
    if (/\/conversation_service\.(go|ts|tsx|js|jsx)$/.test(normalizedPath)) {
      hints.push(
        `High-risk changed file: ${file.path} (return separate inline findings for get-or-create unique-key races and active-thread switch races when present; prioritize these before cleanup/orphan issues).`
      );
      continue;
    }
    if (/\/chat\/controllers\/[^/]*chat[^/]*\.(go|ts|tsx|js|jsx)$/.test(normalizedPath)) {
      hints.push(
        `High-risk changed file: ${file.path} (reject user-controlled assistant/tool roles before persisting chat messages).`
      );
      continue;
    }
    if (/(^|\/)packages\/web-script\/src\/backend\/[^/]*(opfs|queue)[^/]*\.(ts|tsx|js|jsx)$/.test(normalizedPath)) {
      hints.push(
        `High-risk changed file: ${file.path} (verify buffered events cannot be lost across concurrent enqueue, flush, unload, or storage clearing).`
      );
      continue;
    }
    if (file.risk === "high") {
      hints.push(`High-risk changed file: ${file.path} (prioritize correctness and regressions).`);
    } else if (file.risk === "medium") {
      const focus = isStatefulReviewPath(file.path)
        ? "check concurrency, transaction boundaries, idempotency, and auth edge cases"
        : "check edge cases and tests";
      hints.push(`Medium-risk changed file: ${file.path} (${focus}).`);
    }
  }
  for (const hotspot of params.hotspots.slice(0, 4)) {
    if (hotspot.openFindings <= 0) continue;
    hints.push(
      `Historical hotspot: ${hotspot.path} has ${hotspot.openFindings} open finding(s) in categories ${hotspot.topCategories.join(", ") || "unknown"}.`
    );
  }
  for (const link of params.graphLinks.slice(0, 8)) {
    if (link.type !== "file_dep" && link.type !== "file_dep_inferred") continue;
    hints.push(`Cross-file dependency: ${link.from} depends on ${link.to}.`);
  }
  for (const item of params.graphPaths.slice(0, 3)) {
    if (!item.via || item.via.length === 0) continue;
    hints.push(`Traversal path to ${item.path}: ${item.via[0]}.`);
  }
  return Array.from(new Set(hints)).slice(0, 16);
}

function sortChangedStats(stats: ContextPack["changedFileStats"]): ContextPack["changedFileStats"] {
  return [...stats].sort((a, b) => {
    const riskDiff = RISK_SCORE[b.risk] - RISK_SCORE[a.risk];
    if (riskDiff !== 0) return riskDiff;
    const churnA = (a.additions || 0) + (a.deletions || 0);
    const churnB = (b.additions || 0) + (b.deletions || 0);
    if (churnB !== churnA) return churnB - churnA;
    return a.path.localeCompare(b.path);
  });
}

export function buildChunkContextConfig(config: RepoConfig): Pick<RepoConfig, "retrieval" | "graph"> {
  return {
    retrieval: {
      ...config.retrieval,
      topK: Math.min(config.retrieval.topK, CHUNK_RETRIEVAL_TOP_K),
      maxPerPath: Math.min(config.retrieval.maxPerPath, CHUNK_RETRIEVAL_MAX_PER_PATH)
    },
    graph: {
      ...config.graph,
      traversal: {
        ...config.graph.traversal,
        max_depth: Math.min(config.graph.traversal.max_depth, CHUNK_GRAPH_MAX_DEPTH),
        max_related_files: Math.min(
          config.graph.traversal.max_related_files,
          CHUNK_GRAPH_MAX_RELATED_FILES
        ),
        max_graph_links: Math.min(config.graph.traversal.max_graph_links, CHUNK_GRAPH_MAX_LINKS),
        hard_include_files: Math.min(
          config.graph.traversal.hard_include_files,
          CHUNK_GRAPH_HARD_INCLUDE_FILES
        ),
        max_nodes_visited: Math.min(config.graph.traversal.max_nodes_visited, CHUNK_GRAPH_MAX_NODES)
      }
    }
  };
}

export function scopeContextPackToChunk(contextPack: ContextPack, chunk: ReviewDiffChunk): ContextPack {
  const paths = chunkPathSet(chunk);
  const modules = new Set(chunk.paths.map(modulePrefix).filter(Boolean));
  const isChunkPath = (filePath: string | undefined) => Boolean(filePath && paths.has(normalizePath(filePath)));
  const isRelevantPath = (filePath: string | undefined) => {
    if (!filePath) return false;
    const normalized = normalizePath(filePath);
    return paths.has(normalized) || modules.has(modulePrefix(normalized));
  };
  const changedFileStats = sortChangedStats(
    contextPack.changedFileStats.filter((stat) => isChunkPath(stat.path))
  ).slice(0, CHUNK_CONTEXT_MAX_CHANGED_STATS);
  const relatedFiles = contextPack.relatedFiles.filter(isRelevantPath).slice(0, CHUNK_GRAPH_MAX_RELATED_FILES);
  const relatedSet = new Set(relatedFiles.map(normalizePath));
  const graphLinks = contextPack.graphLinks
    .filter(
      (link) =>
        paths.has(normalizePath(link.from)) ||
        paths.has(normalizePath(link.to)) ||
        relatedSet.has(normalizePath(link.from)) ||
        relatedSet.has(normalizePath(link.to))
    )
    .slice(0, CHUNK_GRAPH_MAX_LINKS);
  const graphPaths = contextPack.graphPaths
    .filter((item) => isRelevantPath(item.path) || relatedSet.has(normalizePath(item.path)))
    .slice(0, 8);
  const hotspots = contextPack.hotspots
    .filter((hotspot) => isChunkPath(hotspot.path) || relatedSet.has(normalizePath(hotspot.path)))
    .slice(0, 6);
  const retrieved = contextPack.retrieved
    .filter((item) => item.isPattern || isRelevantPath(item.path))
    .slice(0, CHUNK_RETRIEVAL_TOP_K);
  const reviewFocus = buildChunkFocus({
    chunk,
    changedFileStats,
    hotspots,
    graphLinks,
    graphPaths
  });
  return {
    ...contextPack,
    query: [
      `Chunk ${chunk.id} changed lines: ${chunk.changedLines}`,
      `Changed files:\n${chunk.paths.slice(0, CHUNK_CONTEXT_MAX_CHANGED_STATS).join("\n")}${
        chunk.paths.length > CHUNK_CONTEXT_MAX_CHANGED_STATS ? "\n..." : ""
      }`
    ].join("\n\n"),
    retrieved,
    relatedFiles,
    changedFileStats,
    graphLinks,
    graphPaths,
    hotspots,
    reviewFocus
  };
}

export function chunkHasHighImpactHotspot(contextPack: ContextPack, chunk: ReviewDiffChunk): boolean {
  const paths = chunkPathSet(chunk);
  return contextPack.hotspots.some(
    (hotspot) =>
      paths.has(normalizePath(hotspot.path)) &&
      hotspot.openFindings > 0 &&
      hotspot.topCategories.some((category) => HIGH_IMPACT_HOTSPOT_CATEGORIES.has(category))
  );
}

export async function buildContextPackForChunk(params: {
  repoId: number;
  chunk: ReviewDiffChunk;
  config: RepoConfig;
  prTitle?: string | null;
  prBody?: string | null;
  fallbackContextPack: ContextPack;
}): Promise<ContextPack> {
  const { retrieval, graph } = buildChunkContextConfig(params.config);
  try {
    const { buildContextPack } = await import("./context.js");
    const contextPack = await buildContextPack({
      repoId: params.repoId,
      diffPatch: params.chunk.diffPatch,
      changedFiles: params.chunk.changedFiles as Array<{
        filename?: string;
        path?: string;
        status?: string;
        additions?: number;
        deletions?: number;
      }>,
      prTitle: params.prTitle,
      prBody: params.prBody,
      retrieval,
      graph
    });
    return scopeContextPackToChunk(contextPack, params.chunk);
  } catch (err) {
    console.warn("[chunk-context] falling back to scoped whole-PR context", {
      chunk: params.chunk.id,
      error: err instanceof Error ? err.message : String(err)
    });
    return scopeContextPackToChunk(params.fallbackContextPack, params.chunk);
  }
}
