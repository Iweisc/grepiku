import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execa } from "execa";

test("createRepoCommandWorkspace clones tracked and untracked working tree changes into an isolated repo", async () => {
  const { createRepoCommandWorkspace } = await import("../src/review/repoCommandWorkspace.js");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-repo-command-workspace-"));
  const sourceRepoPath = path.join(root, "source");
  const workspaceBaseDir = path.join(root, "workspaces");

  try {
    await execa("git", ["init", sourceRepoPath]);
    await execa("git", ["-C", sourceRepoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", sourceRepoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(sourceRepoPath, "tracked.txt"), "base\n", "utf8");
    await execa("git", ["-C", sourceRepoPath, "add", "tracked.txt"]);
    await execa("git", ["-C", sourceRepoPath, "commit", "-m", "base"]);

    await fs.writeFile(path.join(sourceRepoPath, "tracked.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(sourceRepoPath, "new.txt"), "new file\n", "utf8");

    const workspace = await createRepoCommandWorkspace({
      sourceRepoPath,
      baseDir: workspaceBaseDir,
      label: "mention-123"
    });

    try {
      assert.notEqual(workspace.repoPath, sourceRepoPath);
      assert.equal(path.dirname(workspace.repoPath), workspace.root);
      assert.equal(path.relative(workspace.root, sourceRepoPath).startsWith(".."), true);
      assert.equal(await fs.readFile(path.join(workspace.repoPath, "tracked.txt"), "utf8"), "changed\n");
      assert.equal(await fs.readFile(path.join(workspace.repoPath, "new.txt"), "utf8"), "new file\n");
      const alternatesExists = await fs
        .stat(path.join(workspace.repoPath, ".git", "objects", "info", "alternates"))
        .then(() => true)
        .catch(() => false);
      assert.equal(alternatesExists, false);

      const { stdout: gitDir } = await execa("git", ["-C", workspace.repoPath, "rev-parse", "--git-dir"]);
      assert.ok(gitDir.trim().length > 0);
    } finally {
      await workspace.cleanup();
    }

    const workspaceExists = await fs
      .stat(path.join(workspaceBaseDir, "mention-123"))
      .then(() => true)
      .catch(() => false);
    assert.equal(workspaceExists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("createRepoCommandWorkspace rejects tracked symlinks that escape the isolated workspace", async () => {
  const { createRepoCommandWorkspace } = await import("../src/review/repoCommandWorkspace.js");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-repo-command-symlink-"));
  const sourceRepoPath = path.join(root, "source");
  const workspaceBaseDir = path.join(root, "workspaces");
  const outsidePath = path.join(root, "outside.txt");

  try {
    await execa("git", ["init", sourceRepoPath]);
    await execa("git", ["-C", sourceRepoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", sourceRepoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(outsidePath, "host secret\n", "utf8");
    await fs.writeFile(path.join(sourceRepoPath, "tracked.txt"), "base\n", "utf8");
    await fs.symlink(outsidePath, path.join(sourceRepoPath, "escape.txt"));
    await execa("git", ["-C", sourceRepoPath, "add", "tracked.txt", "escape.txt"]);
    await execa("git", ["-C", sourceRepoPath, "commit", "-m", "base"]);

    await assert.rejects(
      () =>
        createRepoCommandWorkspace({
          sourceRepoPath,
          baseDir: workspaceBaseDir,
          label: "mention-symlink"
        }),
      /outside the isolated workspace/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("createRepoCommandWorkspace rejects untracked symlinks that escape the isolated workspace", async () => {
  const { createRepoCommandWorkspace } = await import("../src/review/repoCommandWorkspace.js");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-repo-command-untracked-symlink-"));
  const sourceRepoPath = path.join(root, "source");
  const workspaceBaseDir = path.join(root, "workspaces");
  const outsidePath = path.join(root, "outside.txt");

  try {
    await execa("git", ["init", sourceRepoPath]);
    await execa("git", ["-C", sourceRepoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", sourceRepoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(sourceRepoPath, "tracked.txt"), "base\n", "utf8");
    await execa("git", ["-C", sourceRepoPath, "add", "tracked.txt"]);
    await execa("git", ["-C", sourceRepoPath, "commit", "-m", "base"]);

    await fs.writeFile(outsidePath, "host secret\n", "utf8");
    await fs.symlink(outsidePath, path.join(sourceRepoPath, "escape-untracked.txt"));

    await assert.rejects(
      () =>
        createRepoCommandWorkspace({
          sourceRepoPath,
          baseDir: workspaceBaseDir,
          label: "mention-untracked-symlink"
        }),
      /outside the isolated workspace/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("createRepoCommandWorkspace rejects oversized tracked diffs before buffering large patches", async () => {
  const { createRepoCommandWorkspace } = await import("../src/review/repoCommandWorkspace.js");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-repo-command-large-diff-"));
  const sourceRepoPath = path.join(root, "source");
  const workspaceBaseDir = path.join(root, "workspaces");

  try {
    await execa("git", ["init", sourceRepoPath]);
    await execa("git", ["-C", sourceRepoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", sourceRepoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(sourceRepoPath, "tracked.txt"), "base\n", "utf8");
    await execa("git", ["-C", sourceRepoPath, "add", "tracked.txt"]);
    await execa("git", ["-C", sourceRepoPath, "commit", "-m", "base"]);

    await fs.writeFile(path.join(sourceRepoPath, "tracked.txt"), `${"changed line\n".repeat(400)}`, "utf8");

    await assert.rejects(
      () =>
        createRepoCommandWorkspace({
          sourceRepoPath,
          baseDir: workspaceBaseDir,
          label: "mention-large-diff",
          trackedDiffMaxBytes: 1024
        }),
      /repo command workspace output exceeded byte limit/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
