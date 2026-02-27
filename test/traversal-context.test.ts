import test from "node:test";
import assert from "node:assert/strict";
import { __contextInternals } from "../src/review/context.js";

test("parseChangedLinesByPath captures changed hunk lines", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " line1",
    "-line2",
    "+line2b",
    "+line2c",
    " line3"
  ].join("\n");

  const changed = __contextInternals.parseChangedLinesByPath(patch);
  const lines = changed.get("src/a.ts") || new Set<number>();
  assert.equal(lines.has(2), true);
  assert.equal(lines.has(3), true);
});

test("parseChangedLinesByPath expands consecutive deletions across a line span", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,0 @@",
    "-line10",
    "-line11",
    "-line12"
  ].join("\n");

  const changed = __contextInternals.parseChangedLinesByPath(patch);
  const lines = changed.get("src/a.ts") || new Set<number>();
  assert.equal(lines.has(10), true);
  assert.equal(lines.has(11), true);
  assert.equal(lines.has(12), true);
});

test("fanout and budget internals stay deterministic", () => {
  assert.equal(__contextInternals.localEdgeFanout("file_dep"), 8);
  assert.equal(__contextInternals.localEdgeFanout("dir_contains_file"), 2);
  assert.equal(__contextInternals.localEdgeFanout("references_symbol"), 8);
  assert.equal(__contextInternals.localEdgeFanout("contains_symbol"), 4);

  assert.equal(__contextInternals.globalEdgeBudget("file_dep", 2400), 880);
  assert.equal(__contextInternals.globalEdgeBudget("file_dep", 1200), 440);
});

test("buildProvenanceTrace returns ordered chain", () => {
  const parentByNode = new Map<number, { fromNodeId: number; edgeType: string }>([
    [2, { fromNodeId: 1, edgeType: "contains_symbol" }],
    [3, { fromNodeId: 2, edgeType: "file_dep" }]
  ]);
  const nodeById = new Map<number, any>([
    [1, { id: 1, type: "file", key: "src/a.ts", fileId: 11 }],
    [2, { id: 2, type: "symbol", key: "src/a.ts:fn:10", fileId: 11 }],
    [3, { id: 3, type: "file", key: "src/b.ts", fileId: 12 }]
  ]);

  const trace = __contextInternals.buildProvenanceTrace({
    targetNodeId: 3,
    parentByNode,
    nodeById,
    maxSteps: 5
  });

  assert.equal(trace.length, 2);
  assert.match(trace[0], /src\/a\.ts --contains_symbol-->/);
  assert.match(trace[1], /file_dep-->/);
});

test("isStaleFrontierEntry identifies entries superseded by better score/depth", () => {
  const bestScore = new Map<number, number>([[42, 0.9]]);
  const bestDepth = new Map<number, number>([[42, 2]]);

  assert.equal(
    __contextInternals.isStaleFrontierEntry({
      current: { nodeId: 42, score: 0.7, depth: 3 },
      bestScore,
      bestDepth
    }),
    true
  );

  assert.equal(
    __contextInternals.isStaleFrontierEntry({
      current: { nodeId: 42, score: 0.95, depth: 3 },
      bestScore,
      bestDepth
    }),
    false
  );
});
