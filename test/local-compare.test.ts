import assert from "node:assert/strict";
import test from "node:test";
import { mergeLocalChangedFiles } from "../src/review/localCompare.js";

test("mergeLocalChangedFiles merges status and numstat output", () => {
  const nameStatus = ["M\tsrc/a.ts", "A\tsrc/new.ts", "R100\tsrc/old.ts\tsrc/renamed.ts"].join("\n");
  const numStat = ["12\t3\tsrc/a.ts", "8\t0\tsrc/new.ts", "1\t1\tsrc/renamed.ts"].join("\n");

  const merged = mergeLocalChangedFiles(nameStatus, numStat);
  const byPath = new Map(merged.map((item) => [item.path, item]));

  assert.equal(byPath.get("src/a.ts")?.status, "modified");
  assert.equal(byPath.get("src/a.ts")?.additions, 12);
  assert.equal(byPath.get("src/a.ts")?.deletions, 3);

  assert.equal(byPath.get("src/new.ts")?.status, "added");
  assert.equal(byPath.get("src/new.ts")?.additions, 8);
  assert.equal(byPath.get("src/new.ts")?.deletions, 0);

  assert.equal(byPath.get("src/renamed.ts")?.status, "renamed");
  assert.equal(byPath.get("src/renamed.ts")?.additions, 1);
  assert.equal(byPath.get("src/renamed.ts")?.deletions, 1);
});
