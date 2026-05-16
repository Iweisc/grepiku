import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __traversalQualityInternals } from "../src/tools/traversalQuality.js";

test("parseArgs ignores invalid numeric values for limit/since-days/concurrency", () => {
  const options = __traversalQualityInternals.parseArgs([
    "--limit=wat",
    "--since-days=oops",
    "--concurrency=nan"
  ]);

  assert.equal(options.limit, 400);
  assert.equal(options.sinceDays, undefined);
  assert.equal(options.concurrency, 4);
});

test("parseArgs clamps valid numeric values", () => {
  const options = __traversalQualityInternals.parseArgs([
    "--limit=6000",
    "--since-days=0",
    "--concurrency=99"
  ]);

  assert.equal(options.limit, 5000);
  assert.equal(options.sinceDays, 1);
  assert.equal(options.concurrency, 16);
});

test("parseArgs truncates fractional limit and concurrency values", () => {
  const options = __traversalQualityInternals.parseArgs([
    "--limit=250.9",
    "--concurrency=3.8"
  ]);

  assert.equal(options.limit, 250);
  assert.equal(options.concurrency, 3);
});

test("readReplayBundle returns null when replay bundle artifacts exceed the file cap", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-traversal-bundle-"));
  const bundleDir = path.join(root, "var", "runs", "99", "bundle");

  try {
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "diff.patch"), "x".repeat(10 * 1024 * 1024 + 1), "utf8");
    await fs.writeFile(
      path.join(bundleDir, "changed_files.json"),
      JSON.stringify([{ path: "src/app.ts" }]),
      "utf8"
    );

    const replay = await __traversalQualityInternals.readReplayBundle(root, 99);
    assert.equal(replay, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
