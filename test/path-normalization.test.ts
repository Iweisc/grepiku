import assert from "node:assert/strict";
import test from "node:test";
import { __contextInternals } from "../src/review/context.js";
import { buildDiffIndex, normalizeDiffPath, normalizePath } from "../src/review/diff.js";
import { __retrievalInternals } from "../src/services/retrieval.js";

test("normalizePath preserves top-level a and b directories", () => {
  assert.equal(normalizePath("a/src/main.ts"), "a/src/main.ts");
  assert.equal(normalizePath("b/src/main.ts"), "b/src/main.ts");
  assert.equal(normalizePath("./a/src/main.ts"), "a/src/main.ts");
});

test("normalizeDiffPath strips a single git diff prefix", () => {
  assert.equal(normalizeDiffPath("a/src/main.ts"), "src/main.ts");
  assert.equal(normalizeDiffPath("b/src/main.ts"), "src/main.ts");
  assert.equal(normalizeDiffPath("a/a/src/main.ts"), "a/src/main.ts");
  assert.equal(normalizeDiffPath("b/b/src/main.ts"), "b/src/main.ts");
});

test("buildDiffIndex keeps real top-level directories from diff headers", () => {
  const patch = [
    "diff --git a/a/src/main.ts b/a/src/main.ts",
    "--- a/a/src/main.ts",
    "+++ b/a/src/main.ts",
    "@@ -1 +1 @@",
    "-oldA",
    "+newA",
    "diff --git a/b/lib/util.ts b/b/lib/util.ts",
    "--- a/b/lib/util.ts",
    "+++ b/b/lib/util.ts",
    "@@ -10 +10 @@",
    "-oldB",
    "+newB"
  ].join("\n");

  const index = buildDiffIndex(patch);
  assert.equal(index.files.has("a/src/main.ts"), true);
  assert.equal(index.files.has("b/lib/util.ts"), true);
});

test("parseChangedLinesByPath preserves top-level b directory paths", () => {
  const patch = [
    "diff --git a/b/lib/util.ts b/b/lib/util.ts",
    "--- a/b/lib/util.ts",
    "+++ b/b/lib/util.ts",
    "@@ -10 +10 @@",
    "-oldB",
    "+newB"
  ].join("\n");

  const changed = __contextInternals.parseChangedLinesByPath(patch);
  assert.equal(changed.has("b/lib/util.ts"), true);
  assert.equal(changed.has("lib/util.ts"), false);
});

test("retrieval normalization preserves top-level a and b directories", () => {
  assert.equal(__retrievalInternals.normalizeRepoPath("a/src/main.ts"), "a/src/main.ts");
  assert.equal(__retrievalInternals.normalizeRepoPath("b/src/main.ts"), "b/src/main.ts");
});
