import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("walkIndexableFiles yields incrementally so callers can stop before scanning sibling directories", async () => {
  const { walkIndexableFiles } = await import("../src/services/indexerWalk.js");
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-indexer-walk-"));
  const originalReaddir = fs.readdir;
  const visitedDirs: string[] = [];

  try {
    await fs.mkdir(path.join(tmpRoot, "a"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "b"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "a", "first.txt"), "first", "utf8");
    await fs.writeFile(path.join(tmpRoot, "b", "second.txt"), "second", "utf8");
    await fs.writeFile(path.join(tmpRoot, "node_modules", "ignored.txt"), "ignored", "utf8");

    fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
      const dirPath = path.resolve(String(args[0]));
      visitedDirs.push(path.relative(tmpRoot, dirPath) || ".");
      const entries = await originalReaddir(...args);
      if (Array.isArray(entries) && args[1] && typeof args[1] === "object" && "withFileTypes" in args[1]) {
        return [...entries].sort((left: any, right: any) => left.name.localeCompare(right.name));
      }
      return entries;
    }) as typeof fs.readdir;

    const iterator = walkIndexableFiles(tmpRoot, new Set(["node_modules"]));
    const first = await iterator.next();
    await iterator.return?.();

    assert.equal(first.done, false);
    assert.equal(path.relative(tmpRoot, first.value || ""), path.join("a", "first.txt"));
    assert.deepEqual(visitedDirs, [".", "a"]);
  } finally {
    fs.readdir = originalReaddir;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
