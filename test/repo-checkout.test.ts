import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { selectSameShaWorktreesForCleanup } from "../src/providers/repoCheckout.js";

test("selectSameShaWorktreesForCleanup prunes stale entries while keeping recent ones", () => {
  const now = 1_000_000;
  const candidates = [
    { path: "/wt/newest", mtimeMs: now - 60_000, registered: true },
    { path: "/wt/newer", mtimeMs: now - 120_000, registered: true },
    { path: "/wt/stale-1", mtimeMs: now - 7 * 60 * 60 * 1000, registered: true },
    { path: "/wt/stale-2", mtimeMs: now - 8 * 60 * 60 * 1000, registered: false },
    { path: "/wt/stale-3", mtimeMs: now - 9 * 60 * 60 * 1000, registered: true }
  ];

  const stale = selectSameShaWorktreesForCleanup({
    candidates,
    nowMs: now,
    ttlMs: 6 * 60 * 60 * 1000,
    keepRecent: 2
  });

  assert.deepEqual(
    stale.map((item) => item.path),
    ["/wt/stale-3", "/wt/stale-2", "/wt/stale-1"]
  );
});

test("selectSameShaWorktreesForCleanup returns empty when no entry is stale", () => {
  const now = 2_000_000;
  const candidates = [
    { path: "/wt/a", mtimeMs: now - 30_000, registered: true },
    { path: "/wt/b", mtimeMs: now - 60_000, registered: true },
    { path: "/wt/c", mtimeMs: now - 90_000, registered: false }
  ];

  const stale = selectSameShaWorktreesForCleanup({
    candidates,
    nowMs: now,
    ttlMs: 6 * 60 * 60 * 1000,
    keepRecent: 2
  });

  assert.deepEqual(stale, []);
});

test("ensureGitRepoCheckout fetches the pull head ref before checking out a fork PR head sha", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-repo-checkout-fork-"));
  const fakeBinDir = path.join(tempRoot, "bin");
  const fakeGitPath = path.join(fakeBinDir, "git");
  const fakeGitLogPath = path.join(tempRoot, "git-log.jsonl");
  const fakeGitPullMarkerPath = path.join(tempRoot, "pull-head-fetched");
  const runnerPath = path.join(tempRoot, "runner.mjs");
  const owner = `checkout-owner-${process.pid}-${Date.now()}`;
  const repo = "fork-pr";
  const headSha = "f".repeat(40);
  const repoCheckoutModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src", "providers", "repoCheckout.ts")
  ).href;
  const projectRoot = path.join(tempRoot, "project-root");

  try {
    await fs.mkdir(fakeBinDir, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(
      fakeGitPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const logPath = process.env.GREPIKU_FAKE_GIT_LOG;
const markerPath = process.env.GREPIKU_FAKE_GIT_PULL_MARKER;
const headSha = process.env.GREPIKU_FAKE_GIT_HEAD_SHA;

if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
}

const hasPullFetch = () => fs.existsSync(markerPath);
const finish = (code, stdout = "", stderr = "") => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
};

if (args[0] === "clone") {
  const target = args[args.length - 1];
  fs.mkdirSync(path.join(target, ".git"), { recursive: true });
  finish(0);
}

if (args.includes("remote") && (args.includes("set-url") || args.includes("set-head"))) {
  finish(0);
}

if (args.includes("fetch")) {
  if (args.some((arg) => arg.includes("refs/pull/123/head"))) {
    fs.writeFileSync(markerPath, "fetched\\n");
  }
  finish(0);
}

if (args.includes("worktree") && args.includes("list")) {
  finish(0);
}

if (args.includes("worktree") && (args.includes("prune") || args.includes("remove"))) {
  finish(0);
}

if (args.includes("rev-parse") && args.includes("--verify")) {
  const candidate = args[args.length - 1];
  if (candidate === headSha && hasPullFetch()) {
    finish(0, headSha + "\\n");
  }
  if (candidate === "origin/HEAD" || candidate === "HEAD") {
    finish(0, "base-head\\n");
  }
  finish(1, "", "fatal: unknown revision\\n");
}

if (args.includes("worktree") && args.includes("add")) {
  const worktreePath = args[args.length - 2];
  const ref = args[args.length - 1];
  if (ref === headSha && hasPullFetch()) {
    fs.mkdirSync(worktreePath, { recursive: true });
    finish(0);
  }
  finish(1, "", "fatal: invalid reference\\n");
}

finish(0);
`,
      { encoding: "utf8", mode: 0o755 }
    );

    await fs.writeFile(
      runnerPath,
      `await import(${JSON.stringify(repoCheckoutModuleUrl)}).then(async ({ ensureGitRepoCheckout }) => {
  const checkoutPath = await ensureGitRepoCheckout({
    owner: ${JSON.stringify(owner)},
    repo: ${JSON.stringify(repo)},
    headSha: process.env.GREPIKU_FAKE_GIT_HEAD_SHA,
    token: "test-token",
    pullRequestNumber: 123
  });
  console.log(JSON.stringify({ checkoutPath }));
});\n`,
      "utf8"
    );

    const env = {
      ...process.env,
      PORT: process.env.PORT || "3000",
      DATABASE_URL: process.env.DATABASE_URL || "postgresql://user:pass@localhost:5432/grepiku_test",
      REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
      GITHUB_APP_ID: process.env.GITHUB_APP_ID || "1",
      GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY || "test-key",
      GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || "test-secret",
      OPENAI_COMPAT_BASE_URL: process.env.OPENAI_COMPAT_BASE_URL || "https://example.test/v1",
      OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY || "test-openai-key",
      PROJECT_ROOT: projectRoot,
      GREPIKU_FAKE_GIT_LOG: fakeGitLogPath,
      GREPIKU_FAKE_GIT_PULL_MARKER: fakeGitPullMarkerPath,
      GREPIKU_FAKE_GIT_HEAD_SHA: headSha,
      PATH: `${fakeBinDir}:${process.env.PATH || ""}`
    };

    await execa("node", ["--import", "tsx", runnerPath], {
      cwd: process.cwd(),
      env
    });

    const gitLog = await fs.readFile(fakeGitLogPath, "utf8");
    assert.match(
      gitLog,
      /refs\/pull\/123\/head:refs\/remotes\/origin\/pull\/123\/head/
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
