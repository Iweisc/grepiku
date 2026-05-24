import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { __benchmarkModeInternals } from "../src/tools/benchmarkMode.js";

const {
  parseCliArgs,
  buildBenchmarkRoot,
  createBenchmarkProviderAdapter,
  resolveBaseSha,
  resolveHeadSha
} = __benchmarkModeInternals;

test("parseCliArgs parses --repo-path correctly", () => {
  const args = parseCliArgs(["--repo-path=/tmp/my-repo"]);
  assert.equal(args.repoPath, "/tmp/my-repo");
  assert.equal(args.format, "json");
  assert.equal(args.trigger, "opened");
  assert.equal(args.indexMode, "auto");
});

test("parseCliArgs parses all benchmark flags", () => {
  const args = parseCliArgs([
    "--repo-path=/tmp/repo",
    "--base=abc123",
    "--head=def456",
    "--title=Custom title",
    "--body=Custom body",
    "--body-file=/tmp/body.md",
    "--output=/tmp/out.json",
    "--format=text",
    "--repo-id=123",
    "--pr-number=456",
    "--trigger=synchronize",
    "--force",
    "--index-mode=never",
    "--keep-worktrees"
  ]);
  assert.equal(args.repoPath, "/tmp/repo");
  assert.equal(args.base, "abc123");
  assert.equal(args.head, "def456");
  assert.equal(args.title, "Custom title");
  assert.equal(args.body, "Custom body");
  assert.equal(args.bodyFile, "/tmp/body.md");
  assert.equal(args.output, "/tmp/out.json");
  assert.equal(args.format, "text");
  assert.equal(args.repoId, 123);
  assert.equal(args.prNumber, 456);
  assert.equal(args.trigger, "synchronize");
  assert.equal(args.force, true);
  assert.equal(args.indexMode, "never");
  assert.equal(args.keepWorktrees, true);
});

test("parseCliArgs maps --index and --no-index aliases", () => {
  assert.equal(parseCliArgs(["--repo-path=/tmp/repo", "--index"]).indexMode, "always");
  assert.equal(parseCliArgs(["--repo-path=/tmp/repo", "--no-index"]).indexMode, "never");
});

test("parseCliArgs defaults format, trigger, and index mode", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo"]);
  assert.equal(args.format, "json");
  assert.equal(args.trigger, "opened");
  assert.equal(args.indexMode, "auto");
  assert.equal(args.force, true);
  assert.equal(args.base, undefined);
  assert.equal(args.head, undefined);
  assert.equal(args.output, undefined);
  assert.equal(args.repoId, undefined);
});

test("parseCliArgs throws on missing required --repo-path", () => {
  assert.throws(() => parseCliArgs([]), {
    name: "ZodError"
  });
});

test("parseCliArgs throws on invalid format value", () => {
  assert.throws(() => parseCliArgs(["--repo-path=/tmp/repo", "--format=xml"]), {
    name: "ZodError"
  });
});

test("parseCliArgs throws on invalid repo id", () => {
  assert.throws(() => parseCliArgs(["--repo-path=/tmp/repo", "--repo-id=0"]), {
    name: "ZodError"
  });
});

test("parseCliArgs throws on invalid trigger", () => {
  assert.throws(() => parseCliArgs(["--repo-path=/tmp/repo", "--trigger=review_requested"]), {
    name: "ZodError"
  });
});

test("parseCliArgs ignores unknown flags", () => {
  const args = parseCliArgs(["--repo-path=/tmp/repo", "--unknown=value", "--verbose"]);
  assert.equal(args.repoPath, "/tmp/repo");
  assert.equal(args.format, "json");
});

test("buildBenchmarkRoot keeps stage state outside the reviewed repository", () => {
  const repoPath = "/tmp/untrusted-repo";
  const runRoot = buildBenchmarkRoot(repoPath);

  assert.equal(runRoot.startsWith(`${repoPath}${path.sep}`), false);
  assert.equal(runRoot.startsWith(path.join(os.tmpdir(), "grepiku-benchmark") + path.sep), true);
});

test("benchmark adapter uses local git data and captures no-op provider side effects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-benchmark-adapter-"));
  const repoPath = path.join(root, "repo");

  try {
    await execa("git", ["init", repoPath]);
    await execa("git", ["-C", repoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", repoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(repoPath, "file.txt"), "one\n", "utf8");
    await execa("git", ["-C", repoPath, "add", "file.txt"]);
    await execa("git", ["-C", repoPath, "commit", "-m", "one"]);
    const { stdout: baseSha } = await execa("git", ["-C", repoPath, "rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repoPath, "file.txt"), "two\n", "utf8");
    await execa("git", ["-C", repoPath, "commit", "-am", "two"]);
    const { stdout: headSha } = await execa("git", ["-C", repoPath, "rev-parse", "HEAD"]);

    const adapter = createBenchmarkProviderAdapter({
      sourceRepoPath: repoPath,
      headWorktreePath: repoPath,
      baseSha: baseSha.trim(),
      headSha: headSha.trim(),
      repo: {
        externalId: "benchmark:test",
        owner: "benchmark",
        name: "repo",
        fullName: "benchmark/repo"
      },
      pullRequest: {
        externalId: "benchmark:pr",
        number: 1,
        title: "Local PR",
        body: "Body",
        state: "open",
        baseSha: baseSha.trim(),
        headSha: headSha.trim(),
        headRepoFullName: "benchmark/repo"
      },
      botLogin: "grepiku-benchmark"
    });

    const client = await adapter.createClient({
      installationId: "benchmark",
      repo: { externalId: "benchmark:test", owner: "benchmark", name: "repo", fullName: "benchmark/repo" },
      pullRequest: { externalId: "benchmark:pr", number: 1, state: "open", headSha: headSha.trim() }
    });
    const diff = await client.fetchDiffPatch();
    assert.match(diff, /two/);

    const summary = await client.createSummaryComment("summary body");
    assert.equal(summary.id, "benchmark-summary-1");
    const updated = await client.updateSummaryComment(summary.id, "updated body");
    assert.equal(updated.body, "updated body");

    const inline = await client.createInlineComment({
      path: "file.txt",
      line: 1,
      side: "RIGHT",
      body: "inline body <!-- grepiku:test -->"
    });
    assert.equal(inline.id, "benchmark-inline-2");
    const listed = await client.listInlineComments({
      bodyIncludes: "<!-- grepiku:",
      authorLogin: "grepiku-benchmark"
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, inline.id);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("benchmark mode ignores inherited git repository env when resolving base and head shas", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-benchmark-git-env-"));
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

test("benchmark mode rejects option-like head refs instead of passing them to git rev-parse", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-benchmark-ref-"));
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
