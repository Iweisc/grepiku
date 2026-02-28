export type TraversalRepoSizeBucket = "small" | "medium" | "large";

export type TraversalRunMetrics = {
  runId: number;
  repoId: number;
  relatedCount: number;
  changedCount: number;
  findingCount: number;
  crossFileFindingCount: number;
  crossFileRecall: number | null;
  supportedPrecision: number | null;
  supportedCount: number;
  supportedByRetrievalCount: number;
  supportedByGraphCount: number;
  traversalMs: number;
  visitedNodes: number;
  traversedEdges: number;
  prunedByBudget: number;
  maxNodesVisited: number;
  repoFileCount: number;
  repoSizeBucket: TraversalRepoSizeBucket;
};

export type TraversalSummary = {
  runCount: number;
  recallSampleCount: number;
  precisionSampleCount: number;
  avgCrossFileRecall: number;
  avgSupportedPrecision: number;
  p95TraversalMs: number;
  p95VisitedNodes: number;
  p95ByBucket: Record<TraversalRepoSizeBucket, { traversalMs: number; visitedNodes: number; runs: number }>;
  thresholdStatus: {
    pass: boolean;
    failures: string[];
  };
};

export type TraversalThresholds = {
  minRuns: number;
  minRecallSamples: number;
  minPrecisionSamples: number;
  minCrossFileRecall: number;
  minSupportedPrecision: number;
  maxP95TraversalMsSmall: number;
  maxP95TraversalMsMedium: number;
  maxP95TraversalMsLarge: number;
  maxP95VisitedNodesSmall: number;
  maxP95VisitedNodesMedium: number;
  maxP95VisitedNodesLarge: number;
};

export const DEFAULT_TRAVERSAL_THRESHOLDS: TraversalThresholds = {
  minRuns: 8,
  minRecallSamples: 3,
  minPrecisionSamples: 8,
  minCrossFileRecall: 0.55,
  minSupportedPrecision: 0.45,
  maxP95TraversalMsSmall: 700,
  maxP95TraversalMsMedium: 1200,
  maxP95TraversalMsLarge: 2000,
  maxP95VisitedNodesSmall: 900,
  maxP95VisitedNodesMedium: 1800,
  maxP95VisitedNodesLarge: 2600
};

function uniqPaths(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asPathArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqPaths(value.map((item) => String(item || "")));
}

function asRetrievedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const path = (item as Record<string, unknown>).path;
    if (typeof path !== "string") continue;
    paths.push(path);
  }
  return uniqPaths(paths);
}

function asGraphPathEvidence(value: unknown): Map<string, { score: number; viaCount: number }> {
  const output = new Map<string, { score: number; viaCount: number }>();
  if (!Array.isArray(value)) return output;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const path = String((item as Record<string, unknown>).path || "").trim();
    if (!path) continue;
    const score = asNumber((item as Record<string, unknown>).score, 0);
    const via = (item as Record<string, unknown>).via;
    const viaCount = Array.isArray(via) ? via.length : 0;
    const existing = output.get(path);
    if (!existing || score > existing.score || viaCount > existing.viaCount) {
      output.set(path, { score, viaCount });
    }
  }
  return output;
}

function asChangedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const path = (item as Record<string, unknown>).path;
    if (typeof path !== "string") continue;
    paths.push(path);
  }
  return uniqPaths(paths);
}

export function repoSizeBucket(fileCount: number): TraversalRepoSizeBucket {
  if (fileCount <= 300) return "small";
  if (fileCount <= 1500) return "medium";
  return "large";
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function computeTraversalRunMetrics(params: {
  runId: number;
  repoId: number;
  contextPack: unknown;
  findings: Array<{ path: string; status?: string | null }>;
  repoFileCount: number;
}): TraversalRunMetrics | null {
  if (!params.contextPack || typeof params.contextPack !== "object") return null;
  const pack = params.contextPack as Record<string, unknown>;

  const relatedFiles = asPathArray(pack.relatedFiles);
  const changedPaths = asChangedPaths(pack.changedFileStats);
  const retrievedPaths = asRetrievedPaths(pack.retrieved);
  const graphPathEvidence = asGraphPathEvidence(pack.graphPaths);
  const graphDebug =
    pack.graphDebug && typeof pack.graphDebug === "object"
      ? (pack.graphDebug as Record<string, unknown>)
      : {};

  const relatedSet = new Set(relatedFiles);
  const changedSet = new Set(changedPaths);
  const retrievedSet = new Set(retrievedPaths);
  const graphSupportedSet = new Set(
    Array.from(graphPathEvidence.entries())
      .filter(([, evidence]) => evidence.score >= 0.16 || evidence.viaCount > 0)
      .map(([path]) => path)
  );

  const validFindings = params.findings.filter((finding) => String(finding.status || "") !== "obsolete");
  const findingPaths = uniqPaths(validFindings.map((finding) => finding.path));
  const crossFileFindingPaths =
    changedSet.size > 0 ? findingPaths.filter((path) => !changedSet.has(path)) : [];

  const relatedHits = crossFileFindingPaths.filter((path) => relatedSet.has(path));
  const crossFileRecall =
    crossFileFindingPaths.length > 0 ? relatedHits.length / crossFileFindingPaths.length : null;

  const supportedByRetrievalCount = relatedFiles.filter((path) => retrievedSet.has(path)).length;
  const supportedByGraphCount = relatedFiles.filter((path) => graphSupportedSet.has(path)).length;
  const supportedCount = relatedFiles.filter(
    (path) => crossFileFindingPaths.includes(path) || retrievedSet.has(path) || graphSupportedSet.has(path)
  ).length;
  const supportedPrecision = relatedFiles.length > 0 ? supportedCount / relatedFiles.length : null;

  const traversalMs = asNumber(graphDebug.traversalMs, 0);
  const visitedNodes = asNumber(graphDebug.visitedNodes, 0);
  const traversedEdges = asNumber(graphDebug.traversedEdges, 0);
  const prunedByBudget = asNumber(graphDebug.prunedByBudget, 0);
  const maxNodesVisited = asNumber(graphDebug.maxNodesVisited, 0);

  return {
    runId: params.runId,
    repoId: params.repoId,
    relatedCount: relatedFiles.length,
    changedCount: changedPaths.length,
    findingCount: findingPaths.length,
    crossFileFindingCount: crossFileFindingPaths.length,
    crossFileRecall,
    supportedPrecision,
    supportedCount,
    supportedByRetrievalCount,
    supportedByGraphCount,
    traversalMs,
    visitedNodes,
    traversedEdges,
    prunedByBudget,
    maxNodesVisited,
    repoFileCount: params.repoFileCount,
    repoSizeBucket: repoSizeBucket(params.repoFileCount)
  };
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeTraversalMetrics(
  runs: TraversalRunMetrics[],
  thresholds: TraversalThresholds = DEFAULT_TRAVERSAL_THRESHOLDS
): TraversalSummary {
  const recalls = runs.map((run) => run.crossFileRecall).filter((value): value is number => value !== null);
  const precisions = runs
    .map((run) => run.supportedPrecision)
    .filter((value): value is number => value !== null);
  const latencies = runs.map((run) => run.traversalMs).filter((value) => Number.isFinite(value) && value > 0);
  const visits = runs.map((run) => run.visitedNodes).filter((value) => Number.isFinite(value) && value > 0);

  const byBucket: Record<TraversalRepoSizeBucket, TraversalRunMetrics[]> = {
    small: [],
    medium: [],
    large: []
  };
  for (const run of runs) {
    byBucket[run.repoSizeBucket].push(run);
  }

  const p95ByBucket: TraversalSummary["p95ByBucket"] = {
    small: {
      traversalMs: percentile(byBucket.small.map((run) => run.traversalMs).filter((n) => n > 0), 95),
      visitedNodes: percentile(byBucket.small.map((run) => run.visitedNodes).filter((n) => n > 0), 95),
      runs: byBucket.small.length
    },
    medium: {
      traversalMs: percentile(byBucket.medium.map((run) => run.traversalMs).filter((n) => n > 0), 95),
      visitedNodes: percentile(byBucket.medium.map((run) => run.visitedNodes).filter((n) => n > 0), 95),
      runs: byBucket.medium.length
    },
    large: {
      traversalMs: percentile(byBucket.large.map((run) => run.traversalMs).filter((n) => n > 0), 95),
      visitedNodes: percentile(byBucket.large.map((run) => run.visitedNodes).filter((n) => n > 0), 95),
      runs: byBucket.large.length
    }
  };

  const failures: string[] = [];
  if (runs.length < thresholds.minRuns) {
    failures.push(`runCount=${runs.length} below ${thresholds.minRuns}`);
  } else {
    const avgRecall = mean(recalls);
    const avgPrecision = mean(precisions);
    if (recalls.length < thresholds.minRecallSamples) {
      failures.push(`recallSampleCount=${recalls.length} below ${thresholds.minRecallSamples}`);
    } else if (avgRecall < thresholds.minCrossFileRecall) {
      failures.push(
        `avgCrossFileRecall=${avgRecall.toFixed(3)} below ${thresholds.minCrossFileRecall.toFixed(3)}`
      );
    }
    if (precisions.length < thresholds.minPrecisionSamples) {
      failures.push(`precisionSampleCount=${precisions.length} below ${thresholds.minPrecisionSamples}`);
    } else if (avgPrecision < thresholds.minSupportedPrecision) {
      failures.push(
        `avgSupportedPrecision=${avgPrecision.toFixed(3)} below ${thresholds.minSupportedPrecision.toFixed(3)}`
      );
    }

    if (
      p95ByBucket.small.runs > 0 &&
      p95ByBucket.small.traversalMs > thresholds.maxP95TraversalMsSmall
    ) {
      failures.push(
        `p95TraversalMs.small=${p95ByBucket.small.traversalMs} above ${thresholds.maxP95TraversalMsSmall}`
      );
    }
    if (
      p95ByBucket.medium.runs > 0 &&
      p95ByBucket.medium.traversalMs > thresholds.maxP95TraversalMsMedium
    ) {
      failures.push(
        `p95TraversalMs.medium=${p95ByBucket.medium.traversalMs} above ${thresholds.maxP95TraversalMsMedium}`
      );
    }
    if (
      p95ByBucket.large.runs > 0 &&
      p95ByBucket.large.traversalMs > thresholds.maxP95TraversalMsLarge
    ) {
      failures.push(
        `p95TraversalMs.large=${p95ByBucket.large.traversalMs} above ${thresholds.maxP95TraversalMsLarge}`
      );
    }

    if (
      p95ByBucket.small.runs > 0 &&
      p95ByBucket.small.visitedNodes > thresholds.maxP95VisitedNodesSmall
    ) {
      failures.push(
        `p95VisitedNodes.small=${p95ByBucket.small.visitedNodes} above ${thresholds.maxP95VisitedNodesSmall}`
      );
    }
    if (
      p95ByBucket.medium.runs > 0 &&
      p95ByBucket.medium.visitedNodes > thresholds.maxP95VisitedNodesMedium
    ) {
      failures.push(
        `p95VisitedNodes.medium=${p95ByBucket.medium.visitedNodes} above ${thresholds.maxP95VisitedNodesMedium}`
      );
    }
    if (
      p95ByBucket.large.runs > 0 &&
      p95ByBucket.large.visitedNodes > thresholds.maxP95VisitedNodesLarge
    ) {
      failures.push(
        `p95VisitedNodes.large=${p95ByBucket.large.visitedNodes} above ${thresholds.maxP95VisitedNodesLarge}`
      );
    }
  }

  return {
    runCount: runs.length,
    recallSampleCount: recalls.length,
    precisionSampleCount: precisions.length,
    avgCrossFileRecall: mean(recalls),
    avgSupportedPrecision: mean(precisions),
    p95TraversalMs: percentile(latencies, 95),
    p95VisitedNodes: percentile(visits, 95),
    p95ByBucket,
    thresholdStatus: {
      pass: failures.length === 0,
      failures
    }
  };
}
