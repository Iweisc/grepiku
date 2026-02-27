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
