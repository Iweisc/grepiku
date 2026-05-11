import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function ensureMentionTestEnv(): void {
  const required: Record<string, string> = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/grepiku_test",
    REDIS_URL: "redis://localhost:6379",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "test-key",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENAI_COMPAT_BASE_URL: "https://example.test/v1",
    OPENAI_COMPAT_API_KEY: "test-openai-key",
    PROJECT_ROOT: process.cwd()
  };
  for (const [key, value] of Object.entries(required)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

async function loadMentionInternals() {
  ensureMentionTestEnv();
  const module = await import("../src/review/mentions.js");
  return module.__mentionInternals;
}

test("postMentionReply falls back to summary comment when thread reply fails", async () => {
  const { postMentionReply } = await loadMentionInternals();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const summaries: string[] = [];
  let replyAttempts = 0;
  try {
    await postMentionReply({
      client: {
        createSummaryComment: async (body: string) => {
          summaries.push(body);
        },
        replyToComment: async () => {
          replyAttempts += 1;
          throw new Error("api failed");
        }
      },
      commentId: "101",
      body: "hello",
      replyInThread: true
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(replyAttempts, 1);
  assert.equal(summaries.length, 1);
  assert.match(String(warnings[0]?.[0] || ""), /falling back to summary comment/);
});

test("postMentionReply falls back to summary comment when replyToComment is unavailable", async () => {
  const { postMentionReply } = await loadMentionInternals();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const summaries: string[] = [];
  try {
    await postMentionReply({
      client: {
        createSummaryComment: async (body: string) => {
          summaries.push(body);
        }
      },
      commentId: "102",
      body: "hello",
      replyInThread: true
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(summaries.length, 1);
  assert.match(String(warnings[0]?.[0] || ""), /provider does not support replyToComment; falling back/);
});

test("postMentionReply skips thread endpoint when replyInThread is false", async () => {
  const { postMentionReply } = await loadMentionInternals();
  let replyAttempts = 0;
  const summaries: string[] = [];

  await postMentionReply({
    client: {
      createSummaryComment: async (body: string) => {
        summaries.push(body);
      },
      replyToComment: async () => {
        replyAttempts += 1;
      }
    },
    commentId: "103",
    body: "hello",
    replyInThread: false
  });

  assert.equal(replyAttempts, 0);
  assert.equal(summaries.length, 1);
});

test("buildToolCommandEnv strips server secrets from mention verification subprocesses", async () => {
  const { buildToolCommandEnv } = await loadMentionInternals();
  const env = buildToolCommandEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    TMPDIR: "/tmp/host-tmp",
    TMP: "/tmp/host-tmp",
    TEMP: "/tmp/host-tmp",
    DATABASE_URL: "postgresql://secret-user:secret-pass@db.internal:5432/app",
    GITHUB_PRIVATE_KEY: "very-secret-key",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    INTERNAL_API_KEY: "internal-secret",
    OPENAI_COMPAT_API_KEY: "openai-secret",
    CI: ""
  }, "/tmp/mention-tool-home");

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/mention-tool-home");
  assert.equal(env.XDG_CONFIG_HOME, "/tmp/mention-tool-home/.config");
  assert.equal(env.XDG_CACHE_HOME, "/tmp/mention-tool-home/.cache");
  assert.equal(env.XDG_STATE_HOME, "/tmp/mention-tool-home/.state");
  assert.equal(env.TMPDIR, "/tmp/mention-tool-home/.tmp");
  assert.equal(env.TMP, "/tmp/mention-tool-home/.tmp");
  assert.equal(env.TEMP, "/tmp/mention-tool-home/.tmp");
  assert.equal(env.CI, "1");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.GITHUB_PRIVATE_KEY, undefined);
  assert.equal(env.GITHUB_WEBHOOK_SECRET, undefined);
  assert.equal(env.INTERNAL_API_KEY, undefined);
  assert.equal(env.OPENAI_COMPAT_API_KEY, undefined);
});

test("mention verification tools are wrapped in the Linux sandbox with network disabled", async () => {
  const { buildSandboxedToolCommand } = await loadMentionInternals();

  assert.equal(typeof buildSandboxedToolCommand, "function");

  const invocation = buildSandboxedToolCommand({
    codexExecPath: "/usr/local/bin/codex-exec",
    repoPath: "/tmp/repo",
    homeDir: "/tmp/mention-tool-home",
    command: "npm run lint"
  });

  assert.equal(invocation.command, "/usr/local/bin/codex-exec");
  assert.equal(invocation.options.cwd, "/tmp/repo");
  assert.equal(invocation.options.argv0, "codex-linux-sandbox");
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.includes("--use-bwrap-sandbox"), true);

  const separatorIndex = invocation.args.indexOf("--");
  assert.ok(separatorIndex >= 0);
  assert.deepEqual(invocation.args.slice(separatorIndex + 1), ["/bin/sh", "-lc", "npm run lint"]);

  const policyIndex = invocation.args.indexOf("--sandbox-policy");
  assert.ok(policyIndex >= 0);
  assert.deepEqual(JSON.parse(invocation.args[policyIndex + 1]), {
    type: "workspace-write",
    writable_roots: ["/tmp/repo", "/tmp/mention-tool-home"],
    read_only_access: {
      type: "restricted",
      include_platform_defaults: true,
      readable_roots: []
    },
    network_access: false,
    exclude_tmpdir_env_var: true,
    exclude_slash_tmp: true
  });
});

test("mention verification subprocess options ignore stdout and disable buffering", async () => {
  const { buildMentionToolExecaOptions } = await loadMentionInternals();

  assert.equal(typeof buildMentionToolExecaOptions, "function");

  const options = buildMentionToolExecaOptions({
    timeoutSec: 45
  });

  assert.equal(options.stdout, "ignore");
  assert.equal(options.stderr, "pipe");
  assert.equal(options.buffer, false);
  assert.equal(options.reject, false);
  assert.equal(options.timeout, 45_000);
});

test("buildMentionToolResult suppresses raw repo-command stderr", async () => {
  const { buildMentionToolResult } = await loadMentionInternals();

  assert.equal(typeof buildMentionToolResult, "function");

  const result = buildMentionToolResult({
    exitCode: 1,
    stderr: "AWS_SECRET_ACCESS_KEY=leak-me\nsecond line",
    timedOut: false,
    timeoutSec: 60
  });

  assert.equal(result.status, "fail");
  assert.equal(result.summary, "exited with 1");
  assert.deepEqual(result.top_errors, ["stderr output suppressed for security"]);
});

test("mention implementation blocks worktree git metadata tampering before running host git commands", async () => {
  const { captureRepoGitMetadataState, assertRepoGitMetadataUnchanged } =
    await loadMentionInternals();
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-mention-git-"));
  const gitFile = path.join(repoRoot, ".git");

  try {
    await fs.writeFile(gitFile, "gitdir: /tmp/original-worktree\n", "utf8");
    const state = await captureRepoGitMetadataState(repoRoot);

    await fs.writeFile(gitFile, "gitdir: /tmp/attacker-controlled\n", "utf8");

    await assert.rejects(
      () => assertRepoGitMetadataUnchanged(repoRoot, state),
      /blocked: mention task modified worktree git metadata/
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("mention implementation rejects oversized worktree git metadata files", async () => {
  const { captureRepoGitMetadataState } = await loadMentionInternals();
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-mention-git-oversize-"));
  const gitFile = path.join(repoRoot, ".git");

  try {
    await fs.writeFile(gitFile, `gitdir: ${"x".repeat(20_000)}\n`, "utf8");

    await assert.rejects(
      () => captureRepoGitMetadataState(repoRoot),
      /blocked: mention task modified worktree git metadata/
    );
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("mention verification fails closed when Linux sandboxing is unavailable", async () => {
  const { runMentionTool } = await loadMentionInternals();

  assert.equal(typeof runMentionTool, "function");

  const result = await runMentionTool({
    repoPath: "/tmp/nonexistent-repo",
    toolName: "lint",
    toolConfig: { cmd: "echo unsafe", timeout_sec: 30 },
    platform: "darwin"
  });

  assert.deepEqual(result, {
    status: "error",
    summary: "blocked: mention verification requires Linux sandbox support",
    top_errors: []
  });
});

test("mention verification revalidates workspace symlinks before each tool run", async () => {
  const { runMentionTool } = await loadMentionInternals();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-mention-tool-symlink-"));
  const repoPath = path.join(root, "repo");
  const homeDir = path.join(root, "home");
  const outsidePath = path.join(root, "outside.txt");
  const binDir = path.join(root, "bin");
  const codexExecPath = path.join(binDir, "codex-exec");
  const originalPath = process.env.PATH;

  try {
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(outsidePath, "host secret\n", "utf8");
    await fs.symlink(outsidePath, path.join(repoPath, "escape.txt"));
    await fs.writeFile(codexExecPath, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;

    const result = await runMentionTool({
      repoPath,
      toolName: "lint",
      toolConfig: { cmd: "echo ok", timeout_sec: 30 },
      homeDir,
      platform: "linux"
    });

    assert.equal(result.status, "error");
    assert.match(result.summary, /blocked: repo symlink escape\.txt resolves outside the isolated workspace/);
    assert.deepEqual(result.top_errors, []);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resetReplyRunState removes stale stage artifacts before a mention retry", async () => {
  const { resetReplyRunState } = await loadMentionInternals();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-mention-retry-state-"));
  const bundleDir = path.join(root, "bundle");
  const outDir = path.join(root, "out");
  const codexHomeDir = path.join(root, "codex-home");

  try {
    await fs.mkdir(path.join(bundleDir, "repo_hints"), { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(path.join(codexHomeDir, "reviewer"), { recursive: true });
    await fs.writeFile(path.join(outDir, "reply.json"), "{\"body\":\"stale\"}", "utf8");
    await fs.writeFile(path.join(outDir, "mention_action.json"), "{\"action\":\"changed\"}", "utf8");
    await fs.writeFile(path.join(codexHomeDir, "reviewer", "auth.json"), "{\"token\":\"stale\"}", "utf8");

    await resetReplyRunState({ bundleDir, outDir, codexHomeDir });

    await assert.rejects(() => fs.stat(path.join(outDir, "reply.json")), { code: "ENOENT" });
    await assert.rejects(() => fs.stat(path.join(outDir, "mention_action.json")), { code: "ENOENT" });
    await assert.rejects(() => fs.stat(path.join(codexHomeDir, "reviewer", "auth.json")), { code: "ENOENT" });
    const repoHints = await fs.stat(path.join(bundleDir, "repo_hints"));
    assert.equal(repoHints.isDirectory(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mention verification revalidates the isolated tool home before each tool run", async () => {
  const { runMentionTool } = await loadMentionInternals();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-mention-home-symlink-"));
  const repoPath = path.join(root, "repo");
  const homeDir = path.join(root, "home");
  const outsidePath = path.join(root, "outside.txt");
  const binDir = path.join(root, "bin");
  const codexExecPath = path.join(binDir, "codex-exec");
  const originalPath = process.env.PATH;

  try {
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(outsidePath, "host secret\n", "utf8");
    await fs.symlink(outsidePath, path.join(homeDir, "escape.txt"));
    await fs.writeFile(codexExecPath, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;

    const result = await runMentionTool({
      repoPath,
      toolName: "lint",
      toolConfig: { cmd: "echo ok", timeout_sec: 30 },
      homeDir,
      platform: "linux"
    });

    assert.equal(result.status, "error");
    assert.match(result.summary, /blocked: repo symlink escape\.txt resolves outside the isolated workspace/);
    assert.deepEqual(result.top_errors, []);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
