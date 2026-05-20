import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { prisma } from "../db/client.js";
import { buildContextPack } from "../review/context.js";
import { resolveRepoConfig } from "../review/config.js";
import {
  DEFAULT_TRAVERSAL_THRESHOLDS,
  computeTraversalRunMetrics,
  summarizeTraversalMetrics,
  type TraversalThresholds
} from "../services/traversalMetrics.js";

type Options = {
  repoId?: number;
  limit: number;
  sinceDays?: number;
  ci: boolean;
  replay: boolean;
  concurrency: number;
  thresholds: TraversalThresholds;
};

type ReviewRunRow = Awaited<ReturnType<typeof loadRuns>>[number];

type ReplayBundle = {
  diffPatch: string;
  changedFiles: Array<{
    filename?: string;
    path?: string;
    status?: string;
    additions?: number;
    deletions?: number;
  }>;
};

const MAX_REPLAY_DIFF_PATCH_BYTES = 10 * 1024 * 1024;
const MAX_REPLAY_CHANGED_FILES_BYTES = 5 * 1024 * 1024;

function parseFinite(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArgs(argv: string[]): Options {
  const thresholds: TraversalThresholds = { ...DEFAULT_TRAVERSAL_THRESHOLDS };
  const options: Options = {
    limit: 400,
    ci: false,
    replay: false,
    concurrency: 4,
    thresholds
  };

  const numericThresholdKeys: Array<keyof TraversalThresholds> = [
    "minRuns",
    "minRecallSamples",
    "minPrecisionSamples",
    "minCrossFileRecall",
    "minSupportedPrecision",
    "maxP95TraversalMsSmall",
    "maxP95TraversalMsMedium",
    "maxP95TraversalMsLarge",
    "maxP95VisitedNodesSmall",
    "maxP95VisitedNodesMedium",
    "maxP95VisitedNodesLarge"
  ];

  for (const arg of argv) {
    if (arg === "--ci" || arg === "--fail-on-threshold") {
      options.ci = true;
      continue;
    }
    if (arg === "--replay") {
      options.replay = true;
      continue;
    }
    if (arg.startsWith("--repo-id=")) {
      const parsed = parseFinite(arg.slice("--repo-id=".length));
      if (parsed !== null) {
        options.repoId = parsed;
      }
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const parsed = parseFinite(arg.slice("--limit=".length));
      if (parsed !== null) {
        const normalized = Math.trunc(parsed);
        options.limit = Math.max(20, Math.min(5000, normalized));
      }
      continue;
    }
    if (arg.startsWith("--since-days=")) {
      const parsed = parseFinite(arg.slice("--since-days=".length));
      if (parsed !== null) {
        options.sinceDays = Math.max(1, Math.min(365, parsed));
      }
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      const parsed = parseFinite(arg.slice("--concurrency=".length));
      if (parsed !== null) {
        const normalized = Math.trunc(parsed);
        options.concurrency = Math.max(1, Math.min(16, normalized));
      }
      continue;
    }
    for (const key of numericThresholdKeys) {
      const flag = `--${key}=`;
      if (!arg.startsWith(flag)) continue;
      const value = Number(arg.slice(flag.length));
      if (Number.isFinite(value)) {
        (options.thresholds as any)[key] = value;
      }
    }
  }

  return options;
}

function asPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function replayBundleFileLimitError(filePath: string, maxBytes: number): Error {
  return new Error(`replay bundle file exceeded byte limit (${maxBytes} bytes): ${filePath}`);
}

async function readTextFileWithinLimit(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) {
      throw replayBundleFileLimitError(filePath, maxBytes);
    }
    const buffer = Buffer.alloc(Math.max(0, Number(stat.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function loadRuns(options: Options) {
  const where: any = { status: "completed" };
  if (options.repoId) {
    where.pullRequest = { repoId: options.repoId };
  }
  if (options.sinceDays) {
    const since = new Date(Date.now() - options.sinceDays * 24 * 60 * 60 * 1000);
    where.createdAt = { gte: since };
  }

  return prisma.reviewRun.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: options.limit,
    include: {
      pullRequest: { select: { repoId: true, number: true, title: true, body: true } },
      findings: { select: { path: true, status: true } }
    }
  });
}

async function readReplayBundle(projectRoot: string, runId: number): Promise<ReplayBundle | null> {
  const bundleDir = path.join(projectRoot, "var", "runs", String(runId), "bundle");
  const [diffPatch, changedRaw] = await Promise.all([
    readTextFileWithinLimit(
      path.join(bundleDir, "diff.patch"),
      MAX_REPLAY_DIFF_PATCH_BYTES
    ).catch(() => null),
    readTextFileWithinLimit(
      path.join(bundleDir, "changed_files.json"),
      MAX_REPLAY_CHANGED_FILES_BYTES
    ).catch(() => null)
  ]);
  if (!diffPatch || !changedRaw) return null;

  try {
    const parsed = JSON.parse(changedRaw);
    const changedFiles = Array.isArray(parsed) ? parsed : [];
    return { diffPatch, changedFiles };
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function buildReplayContext(run: ReviewRunRow, repoConfigCache: Map<number, Awaited<ReturnType<typeof resolveRepoConfig>>>) {
  const bundle = await readReplayBundle(process.cwd(), run.id);
  if (!bundle) return null;

  let repoConfig = repoConfigCache.get(run.pullRequest.repoId);
  if (!repoConfig) {
    repoConfig = await resolveRepoConfig(run.pullRequest.repoId);
    repoConfigCache.set(run.pullRequest.repoId, repoConfig);
  }

  return buildContextPack({
    repoId: run.pullRequest.repoId,
    diffPatch: bundle.diffPatch,
    changedFiles: bundle.changedFiles,
    headSha: run.headSha,
    prTitle: run.pullRequest.title,
    prBody: run.pullRequest.body,
    retrieval: repoConfig.retrieval,
    graph: repoConfig.graph
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runs = await loadRuns(options);

  const repoFileCounts = new Map<number, number>();
  const repoConfigCache = new Map<number, Awaited<ReturnType<typeof resolveRepoConfig>>>();
  let replayLoaded = 0;
  let replaySkipped = 0;

  const metrics = await mapWithConcurrency(runs, options.concurrency, async (run) => {
    const repoId = run.pullRequest.repoId;
    if (!repoFileCounts.has(repoId)) {
      const count = await prisma.fileIndex.count({ where: { repoId, isPattern: false } });
      repoFileCounts.set(repoId, count);
    }

    let contextPack: unknown = run.contextPackJson;
    if (options.replay) {
      const replay = await buildReplayContext(run, repoConfigCache);
      if (!replay) {
        replaySkipped += 1;
        return null;
      }
      replayLoaded += 1;
      contextPack = replay;
    }

    if (!contextPack || typeof contextPack !== "object") return null;

    return computeTraversalRunMetrics({
      runId: run.id,
      repoId,
      contextPack,
      findings: run.findings,
      repoFileCount: repoFileCounts.get(repoId) || 0
    });
  });

  const validMetrics = metrics.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const summary = summarizeTraversalMetrics(validMetrics, options.thresholds);

  const lines = [
    `Traversal Quality Report${options.replay ? " (replay)" : ""}`,
    `runs=${summary.runCount}`,
    options.replay ? `replayLoaded=${replayLoaded}` : "",
    options.replay ? `replaySkipped=${replaySkipped}` : "",
    `recallSamples=${summary.recallSampleCount}`,
    `precisionSamples=${summary.precisionSampleCount}`,
    `avgCrossFileRecall=${asPercent(summary.avgCrossFileRecall)}`,
    `avgSupportedPrecision=${asPercent(summary.avgSupportedPrecision)}`,
    `p95TraversalMs=${summary.p95TraversalMs}`,
    `p95VisitedNodes=${summary.p95VisitedNodes}`,
    `bucket.small: p95Ms=${summary.p95ByBucket.small.traversalMs}, p95Visited=${summary.p95ByBucket.small.visitedNodes}, runs=${summary.p95ByBucket.small.runs}`,
    `bucket.medium: p95Ms=${summary.p95ByBucket.medium.traversalMs}, p95Visited=${summary.p95ByBucket.medium.visitedNodes}, runs=${summary.p95ByBucket.medium.runs}`,
    `bucket.large: p95Ms=${summary.p95ByBucket.large.traversalMs}, p95Visited=${summary.p95ByBucket.large.visitedNodes}, runs=${summary.p95ByBucket.large.runs}`
  ].filter(Boolean);

  for (const line of lines) {
    console.log(line);
  }

  if (!summary.thresholdStatus.pass) {
    console.log("threshold failures:");
    for (const failure of summary.thresholdStatus.failures) {
      console.log(`- ${failure}`);
    }
    if (options.ci) {
      process.exitCode = 1;
    }
  } else {
    console.log("thresholds: pass");
  }
}

export const __traversalQualityInternals = {
  parseArgs,
  parseFinite,
  readReplayBundle
};

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  main()
    .catch((error) => {
      console.error("Traversal evaluator failed", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
