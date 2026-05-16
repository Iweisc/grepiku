import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execa } from "execa";
import {
  buildLocalChangedFiles,
  captureCommandStdoutWithinLimit,
  isCommandOutputTooLargeError,
  mergeLocalChangedFiles,
  resolveDiffPatchAfterLocalCompareFailure
} from "../src/review/localCompare.js";

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

test("captureCommandStdoutWithinLimit rejects when stdout exceeds the byte cap", async () => {
  await assert.rejects(
    () =>
      captureCommandStdoutWithinLimit({
        file: "bash",
        args: ["-lc", "printf 'x%.0s' {1..128}"],
        maxBytes: 64
      }),
    (error) => {
      assert.equal(isCommandOutputTooLargeError(error), true);
      return true;
    }
  );
});

test("resolveDiffPatchAfterLocalCompareFailure skips local diff after provider diff-too-large errors", async () => {
  let builtLocalDiff = false;
  const error = new Error("diff exceeded") as Error & {
    status?: number;
    response?: { data?: { errors?: Array<{ field?: string; code?: string }> } };
  };
  error.status = 406;
  error.response = {
    data: {
      errors: [{ field: "diff", code: "too_large" }]
    }
  };

  const resolved = await resolveDiffPatchAfterLocalCompareFailure({
    fetchProviderDiff: async () => {
      throw error;
    },
    buildLocalDiff: async () => {
      builtLocalDiff = true;
      return "local diff should not run";
    }
  });

  assert.equal(resolved, "");
  assert.equal(builtLocalDiff, false);
});

test("resolveDiffPatchAfterLocalCompareFailure returns an empty diff when local fallback exceeds the byte cap", async () => {
  const resolved = await resolveDiffPatchAfterLocalCompareFailure({
    fetchProviderDiff: async () => {
      throw new Error("provider unavailable");
    },
    buildLocalDiff: async () => {
      throw new Error("local compare output exceeded byte limit (cap: 64 bytes)");
    }
  });

  assert.equal(resolved, "");
});

test("buildLocalChangedFiles preserves filenames with embedded newlines and tabs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-local-compare-"));
  const repoPath = path.join(root, "repo");
  const weirdPath = `dir/evil\nname\tfile.ts`;

  try {
    await fs.mkdir(path.dirname(path.join(repoPath, weirdPath)), { recursive: true });
    await execa("git", ["init", repoPath]);
    await execa("git", ["-C", repoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", repoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n", "utf8");
    await execa("git", ["-C", repoPath, "add", "tracked.txt"]);
    await execa("git", ["-C", repoPath, "commit", "-m", "base"]);
    const { stdout: baseSha } = await execa("git", ["-C", repoPath, "rev-parse", "HEAD"]);

    await fs.writeFile(path.join(repoPath, weirdPath), "changed\n", "utf8");
    await execa("git", ["-C", repoPath, "add", weirdPath]);
    await execa("git", ["-C", repoPath, "commit", "-m", "weird path"]);
    const { stdout: headSha } = await execa("git", ["-C", repoPath, "rev-parse", "HEAD"]);

    const changedFiles = await buildLocalChangedFiles({
      repoPath,
      baseSha: baseSha.trim(),
      headSha: headSha.trim()
    });

    assert.equal(changedFiles.some((item) => item.path === weirdPath), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
