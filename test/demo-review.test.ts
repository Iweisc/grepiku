import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { __demoReviewInternals } from "../src/tools/demoReview.js";

const {
  parseCliArgs,
  buildDemoRunRoot,
  buildEmptyContextPack,
  readDiffFileWithinLimit,
  loadDemoRepoConfigAtBase,
  resolveBaseSha,
  resolveHeadSha
} = __demoReviewInternals;

test("parseCliArgs parses --repo-path correctly", () => {
  const args = parseCliArgs(["--repo-path=/tmp/my-repo"]);
  assert.equal(args.repoPath, "/tmp/my-repo");
  assert.equal(args.format, "json");
});

test("parseCliArgs parses all flags", () => {
  const args = parseCliArgs([
    "--repo-path=/tmp/repo",
    "--base=abc123",
    "--head=def456",
    "--diff-file=/tmp/diff.patch",
    "--output=/tmp/out.json",
    "--format=text",
    "--repo-id=123",
    "--context-mode=empty"
  ]);
  assert.equal(args.repoPath, "/tmp/repo");
  assert.equal(args.base, "abc123");
  assert.equal(args.head, "def456");
  assert.equal(args.diffFile, "/tmp/diff.patch");
  assert.equal(args.output, "/tmp/out.json");
  assert.equal(args.format, "text");
  assert.equal(args.repoId, 123);
  assert.equal(args.contextMode, "empty");
});

test("parseCliArgs defaults format to json and production context", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo"]);
  assert.equal(args.format, "json");
  assert.equal(args.contextMode, "production");
  assert.equal(args.base, undefined);
  assert.equal(args.head, undefined);
  assert.equal(args.diffFile, undefined);
  assert.equal(args.output, undefined);
  assert.equal(args.repoId, undefined);
});

test("parseCliArgs throws on missing required --repo-path", () => {
  assert.throws(() => parseCliArgs([]), {
    name: "ZodError"
  });
});

test("parseCliArgs throws on missing --repo-path with other flags", () => {
  assert.throws(() => parseCliArgs(["--base=abc", "--head=def"]), {
    name: "ZodError"
  });
});

test("parseCliArgs throws on invalid format value", () => {
  assert.throws(() => parseCliArgs(["--repo-path=/tmp/repo", "--format=xml"]), {
    name: "ZodError"
  });
});

test("parseCliArgs accepts format=json explicitly", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo", "--format=json"]);
  assert.equal(args.format, "json");
});

test("parseCliArgs accepts format=text explicitly", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo", "--format=text"]);
  assert.equal(args.format, "text");
});

test("parseCliArgs accepts repo id as separate argument", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo", "--repo-id", "42"]);
  assert.equal(args.repoId, 42);
});

test("parseCliArgs throws on invalid repo id", () => {
  assert.throws(() => parseCliArgs(["--repo-path=/tmp/repo", "--repo-id=0"]), {
    name: "ZodError"
  });
});

test("parseCliArgs throws on invalid context mode", () => {
  assert.throws(() => parseCliArgs(["--repo-path=/tmp/repo", "--context-mode=demo"]), {
    name: "ZodError"
  });
});

test("parseCliArgs ignores unknown flags", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo", "--unknown=value", "--verbose"]);
  assert.equal(args.repoPath, "/tmp/repo");
  assert.equal(args.format, "json");
});

test("buildEmptyContextPack returns empty retrieval and graph data", () => {
  const pack = buildEmptyContextPack("diff content", [{ path: "src/index.ts" }]);
  assert.equal(pack.retrieved.length, 0);
  assert.equal(pack.relatedFiles.length, 0);
  assert.equal(pack.graphLinks.length, 0);
  assert.equal(pack.graphPaths.length, 0);
  assert.equal(pack.hotspots.length, 0);
  assert.equal(pack.reviewFocus.length, 0);
  assert.equal(pack.changedFileStats.length, 1);
  assert.equal(pack.changedFileStats[0].path, "src/index.ts");
  assert.equal(pack.changedFileStats[0].risk, "low");
  assert.equal(pack.graphDebug.seedNodes, 0);
  assert.equal(pack.graphDebug.traversalMs, 0);
});

test("buildEmptyContextPack handles multiple changed files", () => {
  const pack = buildEmptyContextPack("", [
    { path: "a.ts" },
    { path: "b.ts" },
    { path: "c.ts" }
  ]);
  assert.equal(pack.changedFileStats.length, 3);
  assert.equal(pack.changedFileStats[0].path, "a.ts");
  assert.equal(pack.changedFileStats[1].path, "b.ts");
  assert.equal(pack.changedFileStats[2].path, "c.ts");
});

test("buildDemoRunRoot keeps Codex stage state outside the reviewed repository", () => {
  const repoPath = "/tmp/untrusted-repo";
  const runRoot = buildDemoRunRoot(repoPath);

  assert.equal(runRoot.startsWith(`${repoPath}${path.sep}`), false);
  assert.equal(runRoot.startsWith(path.join(os.tmpdir(), "grepiku-demo") + path.sep), true);
});

test("readDiffFileWithinLimit rejects oversized demo diff inputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-demo-diff-"));
  const diffPath = path.join(root, "oversized.diff");

  try {
    await fs.writeFile(diffPath, "x".repeat(1025), "utf8");

    await assert.rejects(() => readDiffFileWithinLimit(diffPath, 1024), /diff file exceeded byte limit/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("demo review loads repo config from the trusted base commit instead of the working tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-demo-config-"));
  const repoPath = path.join(root, "repo");

  try {
    await execa("git", ["init", repoPath]);
    await execa("git", ["-C", repoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", repoPath, "config", "user.email", "tests@example.com"]);

    await fs.writeFile(
      path.join(repoPath, "grepiku.json"),
      JSON.stringify(
        {
          strictness: "high",
          limits: {
            max_inline_comments: 20,
            max_key_concerns: 5
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await execa("git", ["-C", repoPath, "add", "grepiku.json"]);
    await execa("git", ["-C", repoPath, "commit", "-m", "base config"]);

    const { stdout: baseSha } = await execa("git", ["-C", repoPath, "rev-parse", "HEAD"]);

    await fs.writeFile(
      path.join(repoPath, "grepiku.json"),
      JSON.stringify(
        {
          strictness: "low",
          output: {
            summaryOnly: true
          },
          limits: {
            max_inline_comments: 1,
            max_key_concerns: 1
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const { config } = await loadDemoRepoConfigAtBase(repoPath, baseSha.trim());

    assert.equal(config.strictness, "high");
    assert.equal(config.output.summaryOnly, false);
    assert.equal(config.limits.max_inline_comments, 20);
    assert.equal(config.limits.max_key_concerns, 5);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("demo review ignores inherited git repository env when resolving base and head shas", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-demo-git-env-"));
  const targetRepoPath = path.join(root, "target");
  const alternateRepoPath = path.join(root, "alternate");

  try {
    for (const repoPath of [targetRepoPath, alternateRepoPath]) {
      await execa("git", ["init", repoPath]);
      await execa("git", ["-C", repoPath, "config", "user.name", "Grepiku Tests"]);
      await execa("git", ["-C", repoPath, "config", "user.email", "tests@example.com"]);
      await fs.writeFile(path.join(repoPath, "file.txt"), "one\n", "utf8");
      await execa("git", ["-C", repoPath, "add", "file.txt"]);
      await execa("git", ["-C", repoPath, "commit", "-m", "one"]);
      await fs.writeFile(path.join(repoPath, "file.txt"), "two\n", "utf8");
      await execa("git", ["-C", repoPath, "commit", "-am", "two"]);
    }

    const { stdout: expectedHeadSha } = await execa("git", [
      "-C",
      targetRepoPath,
      "rev-parse",
      "HEAD"
    ]);
    const { stdout: expectedBaseSha } = await execa("git", [
      "-C",
      targetRepoPath,
      "merge-base",
      "HEAD",
      "HEAD~1"
    ]);

    const inheritedEnv = {
      ...process.env,
      GIT_DIR: path.join(alternateRepoPath, ".git"),
      GIT_WORK_TREE: alternateRepoPath
    };

    const resolvedHeadSha = await resolveHeadSha(targetRepoPath, undefined, inheritedEnv);
    const resolvedBaseSha = await resolveBaseSha(targetRepoPath, undefined, inheritedEnv);

    assert.equal(resolvedHeadSha, expectedHeadSha.trim());
    assert.equal(resolvedBaseSha, expectedBaseSha.trim());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("demo review rejects option-like head refs instead of passing them to git rev-parse", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-demo-ref-"));
  const repoPath = path.join(root, "repo");

  try {
    await execa("git", ["init", repoPath]);
    await execa("git", ["-C", repoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", repoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(repoPath, "file.txt"), "one\n", "utf8");
    await execa("git", ["-C", repoPath, "add", "file.txt"]);
    await execa("git", ["-C", repoPath, "commit", "-m", "one"]);

    await assert.rejects(
      () => resolveHeadSha(repoPath, "--show-toplevel"),
      /invalid git ref/i
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
