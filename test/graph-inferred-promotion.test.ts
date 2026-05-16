import test from "node:test";
import assert from "node:assert/strict";
import { __graphInternals } from "../src/services/graph.js";

test("hasDirectFileDepEdge detects direct edge pair for inferred promotion guard", () => {
  const edgeMap = new Map([
    [
      "11:22:file_dep",
      { fromNodeId: 11, toNodeId: 22, type: "file_dep", weight: 1, examples: [] }
    ],
    [
      "11:22:file_dep_inferred",
      { fromNodeId: 11, toNodeId: 22, type: "file_dep_inferred", weight: 3, examples: [] }
    ]
  ]);

  assert.equal(__graphInternals.hasDirectFileDepEdge(edgeMap, { fromNodeId: 11, toNodeId: 22 }), true);
  assert.equal(__graphInternals.hasDirectFileDepEdge(edgeMap, { fromNodeId: 22, toNodeId: 11 }), false);
});

test("evaluateGraphBuildBudget allows repos within safe graph limits", () => {
  const decision = __graphInternals.evaluateGraphBuildBudget({
    fileCount: 12_000,
    symbolCount: 80_000,
    referenceCount: 160_000
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, null);
});

test("evaluateGraphBuildBudget blocks oversized graph inputs before loading them", () => {
  const decision = __graphInternals.evaluateGraphBuildBudget({
    fileCount: 51_000,
    symbolCount: 250_001,
    referenceCount: 500_001
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.reason || "", /file count/i);
  assert.match(decision.reason || "", /symbol count/i);
  assert.match(decision.reason || "", /reference count/i);
});
