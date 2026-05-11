import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { execa } from "execa";

function ensurePrDataTestEnv(): void {
  const required: Record<string, string> = {
    DATABASE_URL: "postgresql://db-user:db-pass@localhost:5432/grepiku_test",
    REDIS_URL: "redis://localhost:6379",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "test-key",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    INTERNAL_API_KEY: "internal-test-key",
    OPENAI_COMPAT_BASE_URL: "https://example.test/v1",
    OPENAI_COMPAT_API_KEY: "test-openai-key",
    PROJECT_ROOT: process.cwd()
  };
  for (const [key, value] of Object.entries(required)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

async function loadPrData() {
  ensurePrDataTestEnv();
  return import("../src/review/pr-data.js");
}

function inheritedChildEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: process.env.PORT || "3000",
    DATABASE_URL:
      process.env.DATABASE_URL || "postgresql://db-user:db-pass@localhost:5432/grepiku_test",
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    GITHUB_APP_ID: process.env.GITHUB_APP_ID || "1",
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY || "test-key",
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || "test-secret",
    OPENAI_COMPAT_BASE_URL: process.env.OPENAI_COMPAT_BASE_URL || "https://example.test/v1",
    OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY || "test-openai-key",
    ...overrides
  };
}

test("fetchDiffPatch uses an authenticated bounded fetch path instead of raw octokit.request buffering", async () => {
  const { fetchDiffPatch } = await loadPrData();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "https://api.github.com/repos/example/repo/pulls/7");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-installation-token");
      assert.equal(headers.get("accept"), "application/vnd.github.v3.diff");
      return new Response("diff --git a/a.ts b/a.ts\n", { status: 200 });
    }) as typeof fetch;

    const octokit = {
      auth: async () => ({ token: "test-installation-token" }),
      request: () => {
        throw new Error("octokit.request should not be called");
      }
    } as any;

    const diff = await fetchDiffPatch(octokit, "example", "repo", 7);
    assert.match(diff, /^diff --git /);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listChangedFiles normalizes provider output and drops raw patch text", async () => {
  const { listChangedFiles } = await loadPrData();
  const rawFiles = [
    {
      filename: "src/app.ts",
      status: "modified",
      additions: 5,
      deletions: 2,
      patch: "secret",
      ignored: "field"
    }
  ];
  const paginate = Object.assign(async () => rawFiles, {
    iterator: async function* () {
      yield { data: rawFiles };
    }
  });
  const octokit = {
    pulls: {
      listFiles: Symbol("listFiles")
    },
    paginate
  } as any;

  const files = await listChangedFiles(octokit, "example", "repo", 7);
  assert.deepEqual(files, [
    {
      path: "src/app.ts",
      status: "modified",
      additions: 5,
      deletions: 2
    }
  ]);
});

test("ensureRepoCheckout keeps legacy helper worktrees inside the repo worktree root", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-pr-data-checkout-"));
  const fakeBinDir = path.join(tempRoot, "bin");
  const fakeGitPath = path.join(fakeBinDir, "git");
  const runnerPath = path.join(tempRoot, "runner.mjs");
  const outputPath = path.join(tempRoot, "result.json");
  const projectRoot = path.join(tempRoot, "project-root");
  const owner = `pr-data-owner-${process.pid}-${Date.now()}`;
  const repo = "legacy-checkout";
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "review", "pr-data.ts")).href;

  try {
    await fs.mkdir(fakeBinDir, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(
      fakeGitPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
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
if (args.includes("remote") || args.includes("fetch")) {
  finish(0);
}
if (args.includes("worktree") && args.includes("remove")) {
  finish(0);
}
if (args.includes("worktree") && args.includes("add")) {
  const worktreePath = args[args.length - 2];
  fs.mkdirSync(worktreePath, { recursive: true });
  finish(0);
}
finish(0);
`,
      { encoding: "utf8", mode: 0o755 }
    );
    await fs.writeFile(
      runnerPath,
      `import fs from "node:fs/promises";
const { ensureRepoCheckout } = await import(${JSON.stringify(moduleUrl)});
const checkoutPath = await ensureRepoCheckout({
  installationToken: "test-token",
  owner: ${JSON.stringify(owner)},
  repo: ${JSON.stringify(repo)},
  headSha: "../escape"
});
await fs.writeFile(${JSON.stringify(outputPath)}, JSON.stringify({ checkoutPath }), "utf8");
`,
      "utf8"
    );

    await execa("node", ["--import", "tsx", runnerPath], {
      cwd: process.cwd(),
      env: inheritedChildEnv({
        PROJECT_ROOT: projectRoot,
        PATH: `${fakeBinDir}:${process.env.PATH || ""}`
      })
    });
    const parsed = JSON.parse(await fs.readFile(outputPath, "utf8")) as { checkoutPath: string };
    const expectedWorktreesRoot = path.join(projectRoot, "var", "repos", owner, `${repo}-worktrees`);
    const relative = path.relative(expectedWorktreesRoot, parsed.checkoutPath);
    const escaped =
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative);

    assert.equal(escaped, false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("buildLocalDiffPatch applies the bounded local compare byte cap", async () => {
  const { buildLocalDiffPatch } = await loadPrData();
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-pr-data-diff-"));

  try {
    await execa("git", ["init"], { cwd: repoPath });
    await execa("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "large.txt"), "base\n", "utf8");
    await execa("git", ["add", "large.txt"], { cwd: repoPath });
    await execa("git", ["commit", "-m", "base"], { cwd: repoPath });
    const { stdout: baseSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: repoPath });

    await fs.writeFile(path.join(repoPath, "large.txt"), "x".repeat(11 * 1024 * 1024), "utf8");
    await execa("git", ["add", "large.txt"], { cwd: repoPath });
    await execa("git", ["commit", "-m", "large"], { cwd: repoPath });
    const { stdout: headSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: repoPath });

    await assert.rejects(
      () =>
        buildLocalDiffPatch({
          repoPath,
          baseSha: baseSha.trim(),
          headSha: headSha.trim()
        }),
      /byte limit/i
    );
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
  }
});
