import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("buildRepoCommandEnv strips verifier secrets before running repo commands", async () => {
  const { buildRepoCommandEnv } = await import("../docker/codex-runner/tools/exec_env.js");
  const env = buildRepoCommandEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    TMPDIR: "/tmp/host-tmp",
    TMP: "/tmp/host-tmp",
    TEMP: "/tmp/host-tmp",
    DATABASE_URL: "postgresql://db-user:db-pass@localhost:5432/grepiku_test",
    REVIEW_RUN_ID: "123",
    WORK_REPO_ROOT: "/tmp/repo",
    INTERNAL_API_KEY: "internal-secret",
    CODEX_HOME: "/tmp/codex-home"
  }, { homeDir: "/tmp/verifier-tool-home" });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/verifier-tool-home");
  assert.equal(env.XDG_CONFIG_HOME, "/tmp/verifier-tool-home/.config");
  assert.equal(env.XDG_CACHE_HOME, "/tmp/verifier-tool-home/.cache");
  assert.equal(env.XDG_STATE_HOME, "/tmp/verifier-tool-home/.state");
  assert.equal(env.TMPDIR, "/tmp/verifier-tool-home/.tmp");
  assert.equal(env.TMP, "/tmp/verifier-tool-home/.tmp");
  assert.equal(env.TEMP, "/tmp/verifier-tool-home/.tmp");
  assert.equal(env.CI, "1");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.REVIEW_RUN_ID, undefined);
  assert.equal(env.WORK_REPO_ROOT, undefined);
  assert.equal(env.INTERNAL_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, undefined);
});

test("gitCheckoutSafetyEnv isolates verifier repo materialization from host git config", async () => {
  const { gitCheckoutSafetyEnv } = await import("../docker/codex-runner/tools/exec_env.js");
  const env = gitCheckoutSafetyEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/host-home",
    XDG_CONFIG_HOME: "/tmp/host-home/.config",
    WORK_OUT_ROOT: "/tmp/review-run/out",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "filter.pwn.smudge",
    GIT_CONFIG_VALUE_0: "/tmp/evil-filter",
    GIT_EXTERNAL_DIFF: "/tmp/evil-diff"
  });

  assert.equal(typeof gitCheckoutSafetyEnv, "function");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.GIT_LFS_SKIP_SMUDGE, "1");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, os.devNull);
  assert.equal(env.HOME, path.resolve("/tmp/review-run/.git-checkout-home"));
  assert.equal(env.XDG_CONFIG_HOME, path.resolve("/tmp/review-run/.git-checkout-home/.config"));
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.equal(env.GIT_CONFIG_KEY_0, "filter.lfs.process");
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  assert.equal(env.GIT_CONFIG_KEY_1, "filter.lfs.smudge");
  assert.equal(env.GIT_CONFIG_VALUE_1, "");
  assert.equal(env.GIT_CONFIG_KEY_2, "filter.lfs.required");
  assert.equal(env.GIT_CONFIG_VALUE_2, "false");
  assert.equal(env.GIT_EXTERNAL_DIFF, undefined);
});

test("verifier repo commands are wrapped in the Linux sandbox with network disabled", async () => {
  const { buildSandboxedRepoCommandInvocation } = await import("../docker/codex-runner/tools/exec_env.js");

  assert.equal(typeof buildSandboxedRepoCommandInvocation, "function");

  const invocation = buildSandboxedRepoCommandInvocation({
    codexExecPath: "/usr/local/bin/codex-exec",
    repoPath: "/tmp/repo",
    homeDir: "/tmp/repo-home",
    command: "pnpm test"
  });

  assert.equal(invocation.file, "/usr/local/bin/codex-exec");
  assert.equal(invocation.options.argv0, "codex-linux-sandbox");
  assert.equal(invocation.options.cwd, "/tmp/repo");
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.includes("--use-bwrap-sandbox"), true);

  const separatorIndex = invocation.args.indexOf("--");
  assert.ok(separatorIndex >= 0);
  assert.deepEqual(invocation.args.slice(separatorIndex + 1), ["/bin/sh", "-lc", "pnpm test"]);

  const policyIndex = invocation.args.indexOf("--sandbox-policy");
  assert.ok(policyIndex >= 0);
  assert.deepEqual(JSON.parse(invocation.args[policyIndex + 1]), {
    type: "workspace-write",
    writable_roots: ["/tmp/repo", "/tmp/repo-home"],
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

test("buildVerifierToolResult suppresses raw repo-command stderr and avoids log files", async () => {
  const { buildVerifierToolResult } = await import("../docker/codex-runner/tools/repo_command_result.js");

  assert.equal(typeof buildVerifierToolResult, "function");

  const result = buildVerifierToolResult({
    exitCode: 1,
    stderr: "AWS_SECRET_ACCESS_KEY=leak-me\nsecond line",
    timedOut: false
  });

  assert.equal(result.status, "fail");
  assert.equal(result.summary, "Exited with 1");
  assert.deepEqual(result.top_errors, ["stderr output suppressed for security"]);
  assert.equal(result.log_path, null);
});

test("buildRepoCommandWorkspacePaths keeps verifier temp state outside the model-readable output root", async () => {
  const { buildRepoCommandWorkspacePaths } = await import("../docker/codex-runner/tools/exec_env.js");

  const paths = buildRepoCommandWorkspacePaths("/tmp/review-run/out");

  assert.equal(paths.stateRoot, path.resolve("/tmp/review-run/.verifier-workspace"));
  assert.equal(paths.repoPath, path.resolve("/tmp/review-run/.verifier-workspace/repo_rw"));
  assert.equal(paths.homeDir, path.resolve("/tmp/review-run/.verifier-workspace/repo_cmd_home"));
  assert.equal(path.relative("/tmp/review-run/out", paths.repoPath).startsWith(".."), true);
  assert.equal(path.relative("/tmp/review-run/out", paths.homeDir).startsWith(".."), true);
});

test("buildIsolatedRepoCloneArgs disables shared local clone optimizations for verifier workspaces", async () => {
  const { buildIsolatedRepoCloneArgs } = await import("../docker/codex-runner/tools/exec_env.js");

  assert.deepEqual(buildIsolatedRepoCloneArgs("/tmp/source-repo", "/tmp/repo-rw"), [
    "clone",
    "--quiet",
    "--no-local",
    "--no-checkout",
    "--",
    "/tmp/source-repo",
    "/tmp/repo-rw"
  ]);
});

test("assertWorkspaceHasNoExternalSymlinks rejects symlinks that escape the verifier workspace", async () => {
  const { assertWorkspaceHasNoExternalSymlinks } = await import("../docker/codex-runner/tools/exec_env.js");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-verifier-workspace-"));
  const outsidePath = path.join(root, "..", path.basename(root) + "-outside.txt");
  const symlinkPath = path.join(root, "escape.txt");

  try {
    await fs.writeFile(outsidePath, "secret\n", "utf8");
    await fs.symlink(outsidePath, symlinkPath);

    await assert.rejects(
      () => assertWorkspaceHasNoExternalSymlinks(root, "verifier workspace"),
      /outside the verifier workspace/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsidePath, { force: true });
  }
});

test("createSerializedToolRunner executes concurrent verifier tasks one at a time", async () => {
  const { createSerializedToolRunner } = await import("../docker/codex-runner/tools/exec_env.js");

  const runSerialized = createSerializedToolRunner();
  const events: string[] = [];

  await Promise.all([
    runSerialized(async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("first:end");
      return "first";
    }),
    runSerialized(async () => {
      events.push("second:start");
      events.push("second:end");
      return "second";
    })
  ]);

  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("verifier revalidates the isolated tool home before each repo command", async () => {
  const script = await fs.readFile(
    new URL("../docker/codex-runner/tools/verifier_mcp.js", import.meta.url),
    "utf8"
  );

  assert.match(
    script,
    /assertWorkspaceHasNoExternalSymlinks\(repoCommandHome,\s*"verifier tool home"\)/
  );
});

test("verifier serializes repo tool commands through a shared execution gate", async () => {
  const script = await fs.readFile(
    new URL("../docker/codex-runner/tools/verifier_mcp.js", import.meta.url),
    "utf8"
  );

  assert.match(script, /const\s+runVerifierToolExclusive\s*=\s*createSerializedToolRunner\(\)/);
  assert.match(script, /await\s+runVerifierToolExclusive\(async\s*\(\)\s*=>\s*\{/);
});

test("verifier supports Kubernetes local cache mode without database credentials", async () => {
  const script = await fs.readFile(
    new URL("../docker/codex-runner/tools/verifier_mcp.js", import.meta.url),
    "utf8"
  );

  assert.match(script, /VERIFIER_CACHE_DIR/);
  assert.match(script, /cacheFileForTool/);
  assert.match(script, /process\.env\.DATABASE_URL\s*\?/);
  assert.match(script, /VERIFIER_REPO_COMMAND_MODE/);
});
