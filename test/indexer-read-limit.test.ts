import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("oversized index candidates are skipped before fs.readFile runs", async () => {
  const { readIndexCandidateFile } = await import("../src/services/indexerFileRead.js");
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-indexer-read-limit-"));
  const filePath = path.join(tmpRoot, "huge.txt");
  const originalReadFile = fs.readFile;
  let readFileCalled = false;

  try {
    await fs.writeFile(filePath, "x", "utf8");
    await fs.truncate(filePath, 1_100_000);

    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      readFileCalled = true;
      return originalReadFile(...args);
    }) as typeof fs.readFile;

    const result = await readIndexCandidateFile(filePath, 1_000_000);

    assert.equal(result, null);
    assert.equal(readFileCalled, false);
  } finally {
    fs.readFile = originalReadFile;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
