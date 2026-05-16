import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReadonlySearchArgs,
  normalizeReadonlyReadBytes,
  normalizeReadonlySearchMaxResults
} from "../docker/codex-runner/tools/readonly_args.js";

test("normalizeReadonlyReadBytes uses safe defaults and clamps oversized reads", () => {
  assert.equal(normalizeReadonlyReadBytes(undefined), 20000);
  assert.equal(normalizeReadonlyReadBytes(-1), 20000);
  assert.equal(normalizeReadonlyReadBytes(4096), 4096);
  assert.equal(normalizeReadonlyReadBytes(999999), 200000);
});

test("normalizeReadonlySearchMaxResults clamps output volume for ripgrep", () => {
  assert.equal(normalizeReadonlySearchMaxResults(undefined), 50);
  assert.equal(normalizeReadonlySearchMaxResults(0), 50);
  assert.equal(normalizeReadonlySearchMaxResults(25), 25);
  assert.equal(normalizeReadonlySearchMaxResults(999), 200);
});

test("buildReadonlySearchArgs inserts bounded match-count and line-width limits before the user query", () => {
  const args = buildReadonlySearchArgs({
    query: "needle",
    glob: "*.ts",
    searchRoot: "/tmp/repo",
    maxResults: 999
  });

  assert.deepEqual(args, [
    "--json",
    "--color",
    "never",
    "--max-count",
    "200",
    "--max-columns",
    "400",
    "--max-columns-preview",
    "--glob",
    "*.ts",
    "--",
    "needle",
    "/tmp/repo"
  ]);
});
