import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execa } from "execa";
import type { RepoConfig } from "./config.js";
import { loadEnv } from "../config/env.js";

export type GraphifyReviewContext = {
  changed_files: string[];
  summary: {
    seed_nodes: number;
    visited_nodes: number;
    max_depth: number;
    max_related_files: number;
  };
  related_files: Array<{
    path: string;
    score: number;
    depth: number;
    community?: number | null;
    top_relations?: string[];
    via?: string[];
  }>;
  graph_links: Array<{
    from: string;
    to: string;
    relation: string;
    score: number;
  }>;
  community_hints?: Array<{
    community: number;
    related_file_count: number;
  }>;
};

export type GraphifyImpact = {
  rankedFiles: Array<{ path: string; graphScore: number; depth: number; via: string[] }>;
  linkCandidates: Array<{ from: string; to: string; type: string; score: number }>;
  debug: {
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
  options: NonNullable<RepoConfig["graph"]["traversal"]>;
};

const GRAPHIFY_CACHE_DIR = "graphify";
const GRAPHIFY_COMMIT_STAMP = ".grepiku-graphify-head";
const inflightGraphBuilds = new Map<string, Promise<string>>();

function graphifyPythonBin(): string {
  const configured = process.env.GRAPHIFY_PYTHON_BIN?.trim();
  return configured && configured.length > 0 ? configured : "python3";
}

function graphifyOutDir(repoPath: string): string {
  const cacheKey = crypto
    .createHash("sha256")
    .update(path.resolve(repoPath))
    .digest("hex")
    .slice(0, 24);
  return path.join(loadEnv().projectRoot, "var", GRAPHIFY_CACHE_DIR, cacheKey);
}

function graphifyGraphPath(repoPath: string): string {
  return path.join(graphifyOutDir(repoPath), "graph.json");
}

function graphifyCommitStampPath(repoPath: string): string {
  return path.join(graphifyOutDir(repoPath), GRAPHIFY_COMMIT_STAMP);
}

async function readGraphCommit(graphPath: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(graphPath, "utf8")) as { built_at_commit?: unknown };
    const fromGraph =
      typeof raw.built_at_commit === "string" && raw.built_at_commit.trim().length > 0
        ? raw.built_at_commit.trim()
        : null;
    if (fromGraph) return fromGraph;
  } catch {
    // fall through to stamp file
  }

  try {
    const stamp = await fs.readFile(path.join(path.dirname(graphPath), GRAPHIFY_COMMIT_STAMP), "utf8");
    const value = stamp.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function resolveCurrentHeadSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function ensureGraphifyGraph(params: { repoPath: string; headSha?: string | null }): Promise<string> {
  const repoPath = params.repoPath;
  const headSha = params.headSha?.trim() || null;
  const graphPath = graphifyGraphPath(repoPath);
  const env = loadEnv();
  const cached = inflightGraphBuilds.get(repoPath);
  if (cached) return cached;

  const work = (async () => {
    const existingCommit = await readGraphCommit(graphPath);
    if (existingCommit && (!headSha || existingCommit === headSha)) {
      return graphPath;
    }

    await execa(graphifyPythonBin(), ["-m", "graphify", "update", ".", "--no-cluster"], {
      cwd: repoPath,
      timeout: env.codexStageTimeoutMs,
      env: {
        ...process.env,
        GRAPHIFY_OUT: graphifyOutDir(repoPath),
        PYTHONUNBUFFERED: "1"
      }
    });

    const updatedCommit = (await resolveCurrentHeadSha(repoPath)) || headSha;
    if (updatedCommit) {
      await fs.mkdir(path.dirname(graphPath), { recursive: true });
      await fs.writeFile(graphifyCommitStampPath(repoPath), `${updatedCommit}\n`, "utf8");
    }
    if (headSha && updatedCommit && updatedCommit !== headSha) {
      console.warn(
        `[graphify] built commit mismatch expected=${headSha.slice(0, 12)} actual=${updatedCommit.slice(0, 12)} repo=${repoPath}`
      );
    }

    await fs.access(graphPath);
    return graphPath;
  })();

  inflightGraphBuilds.set(repoPath, work);
  try {
    return await work;
  } finally {
    inflightGraphBuilds.delete(repoPath);
  }
}

function resolveTraversalOptions(
  traversal: RepoConfig["graph"]["traversal"] | undefined
): NonNullable<RepoConfig["graph"]["traversal"]> {
  return {
    max_depth: traversal?.max_depth ?? 5,
    min_score: traversal?.min_score ?? 0.07,
    max_related_files: traversal?.max_related_files ?? 28,
    max_graph_links: traversal?.max_graph_links ?? 110,
    hard_include_files: traversal?.hard_include_files ?? 8,
    max_nodes_visited: traversal?.max_nodes_visited ?? 2600
  };
}

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/^\/+/, "");
}

function normalizeExcludeDir(value: string): string {
  return normalizeRepoPath(value).replace(/\/+$/, "");
}

function isExcludedPath(filePath: string, excludeDirs: string[]): boolean {
  const normalized = normalizeRepoPath(filePath);
  return excludeDirs.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}

function mapGraphifyRelationToGrepikuType(relation: string): string {
  const normalized = relation.trim().toLowerCase();
  if (normalized === "imports" || normalized === "imports_from") return "file_dep";
  if (normalized === "calls" || normalized === "uses" || normalized === "references") {
    return "file_dep_inferred";
  }
  return normalized || "file_dep_inferred";
}

export async function buildGraphifyReviewContext(params: {
  repoPath: string;
  headSha?: string | null;
  changedFiles: string[];
  graph?: RepoConfig["graph"];
}): Promise<GraphifyReviewContext> {
  const graphPath = await ensureGraphifyGraph({
    repoPath: params.repoPath,
    headSha: params.headSha
  });
  const traversal = resolveTraversalOptions(params.graph?.traversal);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-graphify-review-context-"));
  try {
    const changedFilesPath = path.join(tempDir, "changed_files.json");
    await fs.writeFile(
      changedFilesPath,
      JSON.stringify(params.changedFiles.map((filePath) => ({ filename: filePath })), null, 2),
      "utf8"
    );

    const { stdout } = await execa(
      graphifyPythonBin(),
      [
        "-m",
        "graphify",
        "review-context",
        "--graph",
        graphPath,
        "--changed-files-json",
        changedFilesPath,
        "--max-depth",
        String(traversal.max_depth),
        "--max-related-files",
        String(traversal.max_related_files),
        "--max-graph-links",
        String(traversal.max_graph_links),
        "--max-visited-nodes",
        String(traversal.max_nodes_visited)
      ],
      {
        cwd: params.repoPath,
        timeout: loadEnv().codexStageTimeoutMs,
        env: {
          ...process.env,
          GRAPHIFY_OUT: graphifyOutDir(params.repoPath),
          PYTHONUNBUFFERED: "1"
        }
      }
    );

    return JSON.parse(stdout) as GraphifyReviewContext;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildGraphifyImpact(params: {
  repoPath: string;
  headSha?: string | null;
  changedFiles: string[];
  graph?: RepoConfig["graph"];
}): Promise<GraphifyImpact> {
  const traversal = resolveTraversalOptions(params.graph?.traversal);
  const context = await buildGraphifyReviewContext(params);
  const excludedDirs = (params.graph?.exclude_dirs || []).map(normalizeExcludeDir).filter(Boolean);
  const rankedFiles = context.related_files
    .filter((item) => !isExcludedPath(item.path, excludedDirs))
    .filter((item) => item.score >= traversal.min_score)
    .map((item) => ({
      path: item.path,
      graphScore: item.score,
      depth: item.depth,
      via: item.via || []
    }));
  const allowedPaths = new Set(rankedFiles.map((item) => item.path));

  return {
    rankedFiles,
    linkCandidates: context.graph_links
      .filter((item) => !isExcludedPath(item.from, excludedDirs) && !isExcludedPath(item.to, excludedDirs))
      .filter((item) => allowedPaths.has(item.from) || allowedPaths.has(item.to))
      .map((item) => ({
        from: item.from,
        to: item.to,
        type: mapGraphifyRelationToGrepikuType(item.relation),
        score: item.score
      })),
    debug: {
      seedNodes: context.summary.seed_nodes,
      touchedSymbolSeeds: 0,
      visitedNodes: context.summary.visited_nodes,
      traversedEdges: context.graph_links.length,
      prunedByBudget: 0,
      maxDepth: context.summary.max_depth,
      minScore: traversal.min_score,
      maxNodesVisited: traversal.max_nodes_visited,
      traversalMs: 0
    },
    options: traversal
  };
}

export const __graphifyContextInternals = {
  graphifyOutDir,
  graphifyGraphPath,
  graphifyCommitStampPath,
  graphifyPythonBin,
  readGraphCommit,
  resolveTraversalOptions,
  normalizeRepoPath,
  normalizeExcludeDir,
  isExcludedPath,
  mapGraphifyRelationToGrepikuType
};
