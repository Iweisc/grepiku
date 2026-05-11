import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import {
  commitWorkingTree,
  isGitPermissionDeniedError,
  mentionBranchName,
  prepareMentionBranch,
  resolveFollowUpPrBaseBranch
} from "../src/review/mentionGit.js";

test("resolveFollowUpPrBaseBranch prefers pull request head ref for follow-up PRs", () => {
  const base = resolveFollowUpPrBaseBranch({
    pullRequestHeadRef: "dev",
    pullRequestBaseRef: "release/1.2",
    refreshedHeadRef: "feature/x",
    refreshedBaseRef: "main",
    repoDefaultBranch: "develop"
  });
  assert.equal(base, "dev");
});

test("resolveFollowUpPrBaseBranch falls back to refreshed base ref", () => {
  const base = resolveFollowUpPrBaseBranch({
    pullRequestHeadRef: null,
    pullRequestBaseRef: null,
    refreshedHeadRef: null,
    refreshedBaseRef: "main",
    repoDefaultBranch: "develop"
  });
  assert.equal(base, "main");
});

test("resolveFollowUpPrBaseBranch falls back to repo default and then main", () => {
  const withDefault = resolveFollowUpPrBaseBranch({
    pullRequestHeadRef: "",
    pullRequestBaseRef: "",
    refreshedHeadRef: null,
    refreshedBaseRef: null,
    repoDefaultBranch: "develop"
  });
  assert.equal(withDefault, "develop");

  const fallbackMain = resolveFollowUpPrBaseBranch({
    pullRequestHeadRef: null,
    pullRequestBaseRef: null,
    refreshedHeadRef: undefined,
    refreshedBaseRef: undefined,
    repoDefaultBranch: ""
  });
  assert.equal(fallbackMain, "main");
});

test("mentionBranchName is deterministic per comment id so retries reuse the same branch", () => {
  const first = mentionBranchName("9876543210");
  const second = mentionBranchName("9876543210");
  const different = mentionBranchName("1234567890");

  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.match(first, /^grepiku\/mention-[a-z0-9._-]+-[a-f0-9]{8}$/);
});

test("prepareMentionBranch tolerates an existing local follow-up branch on retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-mention-branch-retry-"));
  const repoPath = path.join(root, "repo");

  try {
    await fs.mkdir(repoPath, { recursive: true });
    await execa("git", ["-C", repoPath, "init"]);
    await execa("git", ["-C", repoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", repoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n", "utf8");
    await execa("git", ["-C", repoPath, "add", "tracked.txt"]);
    await execa("git", ["-C", repoPath, "commit", "-m", "base"]);
    await execa("git", ["-C", repoPath, "switch", "--create", "grepiku/mention-existing"]);

    await prepareMentionBranch({
      repoPath,
      branchName: "grepiku/mention-existing",
      gitUserName: "grepiku[bot]",
      gitUserEmail: "grepiku@users.noreply.github.com"
    });

    const { stdout: configuredName } = await execa("git", [
      "-C",
      repoPath,
      "config",
      "user.name"
    ]);
    const { stdout: configuredEmail } = await execa("git", [
      "-C",
      repoPath,
      "config",
      "user.email"
    ]);

    assert.equal(configuredName.trim(), "grepiku[bot]");
    assert.equal(configuredEmail.trim(), "grepiku@users.noreply.github.com");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("isGitPermissionDeniedError detects push permission failures", () => {
  assert.equal(
    isGitPermissionDeniedError(new Error("remote: Permission to org/repo.git denied to bot[bot].")),
    true
  );
  assert.equal(
    isGitPermissionDeniedError(new Error("The requested URL returned error: 403")),
    true
  );
  assert.equal(isGitPermissionDeniedError(new Error("fatal: not a git repository")), false);
});

test("commitWorkingTree ignores host git filter drivers from global config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-mention-git-filter-"));
  const repoPath = path.join(root, "repo");
  const maliciousHome = path.join(root, "malicious-home");
  const projectRoot = path.join(root, "project");
  const markerPath = path.join(root, "filter-triggered.txt");
  const filterScriptPath = path.join(root, "filter.mjs");
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalProjectRoot = process.env.PROJECT_ROOT;
  const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  const originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

  try {
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(maliciousHome, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });

    await execa("git", ["-C", repoPath, "init"]);
    await execa("git", ["-C", repoPath, "config", "user.name", "Grepiku Tests"]);
    await execa("git", ["-C", repoPath, "config", "user.email", "tests@example.com"]);
    await fs.writeFile(path.join(repoPath, ".gitattributes"), "payload.txt filter=pwn\n", "utf8");
    await fs.writeFile(path.join(repoPath, "payload.txt"), "hello\n", "utf8");
    await execa("git", ["-C", repoPath, "add", ".gitattributes", "payload.txt"]);
    await execa("git", ["-C", repoPath, "commit", "-m", "base"]);

    await fs.writeFile(path.join(repoPath, "payload.txt"), "changed\n", "utf8");
    await fs.writeFile(
      filterScriptPath,
      [
        'import fs from "node:fs";',
        "const markerPath = process.argv[2];",
        'fs.appendFileSync(markerPath, "triggered\\n", "utf8");',
        "process.stdin.pipe(process.stdout);"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(maliciousHome, ".gitconfig"),
      [
        '[filter "pwn"]',
        `    clean = ${process.execPath} ${filterScriptPath} ${markerPath}`
      ].join("\n"),
      "utf8"
    );

    process.env.HOME = maliciousHome;
    process.env.XDG_CONFIG_HOME = path.join(maliciousHome, ".config");
    process.env.PROJECT_ROOT = projectRoot;
    delete process.env.GIT_CONFIG_GLOBAL;
    delete process.env.GIT_CONFIG_NOSYSTEM;

    await commitWorkingTree({
      repoPath,
      message: "test commit"
    });

    const triggered = await fs
      .stat(markerPath)
      .then(() => true)
      .catch(() => false);

    assert.equal(triggered, false);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = originalProjectRoot;
    }
    if (originalGitConfigGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    }
    if (originalGitConfigNoSystem === undefined) {
      delete process.env.GIT_CONFIG_NOSYSTEM;
    } else {
      process.env.GIT_CONFIG_NOSYSTEM = originalGitConfigNoSystem;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
