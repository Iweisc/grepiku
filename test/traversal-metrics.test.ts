import test from "node:test";
import assert from "node:assert/strict";
import {
  computeTraversalRunMetrics,
  summarizeTraversalMetrics,
  DEFAULT_TRAVERSAL_THRESHOLDS
} from "../src/services/traversalMetrics.js";

test("computeTraversalRunMetrics calculates recall and supported precision", () => {
  const metrics = computeTraversalRunMetrics({
    runId: 10,
    repoId: 2,
    repoFileCount: 120,
    contextPack: {
      relatedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      changedFileStats: [{ path: "src/changed.ts" }],
      retrieved: [{ path: "src/b.ts" }, { path: "src/else.ts" }],
      graphDebug: {
        traversalMs: 420,
        visitedNodes: 311,
        traversedEdges: 990,
        prunedByBudget: 40,
        maxNodesVisited: 2400
      }
    },
    findings: [
      { path: "src/a.ts", status: "open" },
      { path: "src/changed.ts", status: "open" },
      { path: "src/noise.ts", status: "obsolete" }
    ]
  });

  assert.ok(metrics);
  assert.equal(metrics?.crossFileFindingCount, 1);
  assert.equal(metrics?.crossFileRecall, 1);
  assert.equal(metrics?.supportedCount, 2);
  assert.equal(metrics?.supportedPrecision, 2 / 3);
  assert.equal(metrics?.repoSizeBucket, "small");
});

test("computeTraversalRunMetrics does not classify cross-file findings without changed-file metadata", () => {
  const metrics = computeTraversalRunMetrics({
    runId: 11,
    repoId: 2,
    repoFileCount: 120,
    contextPack: {
      relatedFiles: ["src/a.ts"],
      retrieved: [{ path: "src/a.ts" }],
      graphDebug: {
        traversalMs: 320,
        visitedNodes: 101,
        traversedEdges: 250,
        prunedByBudget: 11,
        maxNodesVisited: 2400
      }
    },
    findings: [{ path: "src/a.ts", status: "open" }]
  });

  assert.ok(metrics);
  assert.equal(metrics?.changedCount, 0);
  assert.equal(metrics?.crossFileFindingCount, 0);
  assert.equal(metrics?.crossFileRecall, null);
});

test("summarizeTraversalMetrics evaluates thresholds", () => {
  const runs = [
    {
      runId: 1,
      repoId: 1,
      relatedCount: 10,
      changedCount: 2,
      findingCount: 4,
      crossFileFindingCount: 2,
      crossFileRecall: 0.5,
      supportedPrecision: 0.4,
      supportedCount: 4,
      supportedByRetrievalCount: 3,
      supportedByGraphCount: 2,
      traversalMs: 800,
      visitedNodes: 1000,
      traversedEdges: 1200,
      prunedByBudget: 50,
      maxNodesVisited: 2400,
      repoFileCount: 500,
      repoSizeBucket: "medium" as const
    }
  ];

  const summary = summarizeTraversalMetrics(runs, {
    ...DEFAULT_TRAVERSAL_THRESHOLDS,
    minRuns: 1,
    minCrossFileRecall: 0.55,
    minSupportedPrecision: 0.45,
    maxP95TraversalMsMedium: 700
  });

  assert.equal(summary.runCount, 1);
  assert.equal(summary.thresholdStatus.pass, false);
  assert.ok(summary.thresholdStatus.failures.length >= 1);
});

test("summarizeTraversalMetrics fails threshold status when run count is below minRuns", () => {
  const runs = [
    {
      runId: 2,
      repoId: 1,
      relatedCount: 8,
      changedCount: 3,
      findingCount: 3,
      crossFileFindingCount: 1,
      crossFileRecall: 1,
      supportedPrecision: 0.7,
      supportedCount: 6,
      supportedByRetrievalCount: 2,
      supportedByGraphCount: 2,
      traversalMs: 600,
      visitedNodes: 500,
      traversedEdges: 900,
      prunedByBudget: 20,
      maxNodesVisited: 2400,
      repoFileCount: 200,
      repoSizeBucket: "small" as const
    }
  ];

  const summary = summarizeTraversalMetrics(runs, DEFAULT_TRAVERSAL_THRESHOLDS);
  assert.equal(summary.thresholdStatus.pass, false);
  assert.match(summary.thresholdStatus.failures[0] || "", /runCount=1 below/);
});

test("summarizeTraversalMetrics fails when recall/precision samples are below required minimums", () => {
  const runs = [
    {
      runId: 3,
      repoId: 1,
      relatedCount: 8,
      changedCount: 3,
      findingCount: 3,
      crossFileFindingCount: 1,
      crossFileRecall: null,
      supportedPrecision: null,
      supportedCount: 6,
      supportedByRetrievalCount: 2,
      supportedByGraphCount: 2,
      traversalMs: 600,
      visitedNodes: 500,
      traversedEdges: 900,
      prunedByBudget: 20,
      maxNodesVisited: 2400,
      repoFileCount: 200,
      repoSizeBucket: "small" as const
    }
  ];

  const summary = summarizeTraversalMetrics(runs, {
    ...DEFAULT_TRAVERSAL_THRESHOLDS,
    minRuns: 1,
    minRecallSamples: 2,
    minPrecisionSamples: 2
  });
  assert.equal(summary.thresholdStatus.pass, false);
  assert.ok(
    summary.thresholdStatus.failures.some((failure) => failure.includes("recallSampleCount=0 below 2"))
  );
  assert.ok(
    summary.thresholdStatus.failures.some((failure) => failure.includes("precisionSampleCount=0 below 2"))
  );
});
