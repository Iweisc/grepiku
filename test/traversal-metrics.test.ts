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
