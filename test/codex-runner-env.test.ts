import assert from "node:assert/strict";
import test from "node:test";

function ensureRunnerTestEnv(): void {
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

async function loadRunnerInternals() {
  ensureRunnerTestEnv();
  const module = await import("../src/runner/codexRunner.js");
  return module.__codexRunnerInternals;
}

const sampleParams = {
  stage: "mention" as const,
  repoPath: "/tmp/repo",
  bundleDir: "/tmp/bundle",
  outDir: "/tmp/out",
  codexHomeDir: "/tmp/codex-home",
  prompt: "test prompt",
  headSha: "abc123def456",
  repoId: 42,
  reviewRunId: 77,
  prNumber: 13
};

test("mention stage env omits backend secrets from the shell-visible process environment", async () => {
  const { buildStageEnv } = await loadRunnerInternals();
  const env = buildStageEnv(sampleParams, "/tmp/codex-home/mention");

  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.INTERNAL_API_KEY, undefined);
  assert.equal(env.INTERNAL_API_URL, undefined);
  assert.equal(env.REVIEW_RUN_ID, undefined);
  assert.equal(env.REVIEW_REPO_ID, undefined);
  assert.equal(env.TOOLRUN_PR_NUMBER, undefined);
  assert.equal(env.TOOLRUN_HEAD_SHA, undefined);
  assert.equal(env.WORK_BUNDLE_ROOT, undefined);
  assert.equal(env.WORK_OUT_ROOT, undefined);
  assert.equal(env.WORK_REPO_ROOT, undefined);
});

test("mention stage env still includes the codex runtime settings it needs", async () => {
  const { buildStageEnv } = await loadRunnerInternals();
  const env = buildStageEnv(sampleParams, "/tmp/codex-home/mention");

  assert.equal(env.CODEX_HOME, "/tmp/codex-home/mention");
  assert.equal(env.CODEX_DISABLE_PROJECT_DOC, "1");
  assert.equal(env.CODEX_QUIET_MODE, "1");
  assert.equal(env.OPENAI_BASE_URL, "https://example.test/v1");
  assert.equal(env.OPENAI_TIMEOUT_MS, "120000");
  assert.equal(env.OPENAI_MAX_RETRIES, "3");
});

test("mention stage env replaces host home paths with the isolated stage home", async () => {
  const { buildStageEnv } = await loadRunnerInternals();
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.HOME = "/tmp/host-home";
    process.env.XDG_CONFIG_HOME = "/tmp/host-config";

    const env = buildStageEnv(sampleParams, "/tmp/codex-home/mention");

    assert.equal(env.HOME, "/tmp/codex-home/mention");
    assert.equal(env.XDG_CONFIG_HOME, "/tmp/codex-home/mention/.config");
    assert.equal(env.XDG_CACHE_HOME, "/tmp/codex-home/mention/.cache");
    assert.equal(env.XDG_STATE_HOME, "/tmp/codex-home/mention/.state");
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
  }
});

test("mention stage env replaces host temp paths with an isolated stage temp dir", async () => {
  const { buildStageEnv } = await loadRunnerInternals();
  const originalTmpdir = process.env.TMPDIR;
  const originalTmp = process.env.TMP;
  const originalTemp = process.env.TEMP;
  try {
    process.env.TMPDIR = "/tmp/host-stage-tmp";
    process.env.TMP = "/tmp/host-stage-tmp";
    process.env.TEMP = "/tmp/host-stage-tmp";

    const env = buildStageEnv(sampleParams, "/tmp/codex-home/mention");

    assert.equal(env.TMPDIR, "/tmp/codex-home/mention/.tmp");
    assert.equal(env.TMP, "/tmp/codex-home/mention/.tmp");
    assert.equal(env.TEMP, "/tmp/codex-home/mention/.tmp");
  } finally {
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    if (originalTmp === undefined) {
      delete process.env.TMP;
    } else {
      process.env.TMP = originalTmp;
    }
    if (originalTemp === undefined) {
      delete process.env.TEMP;
    } else {
      process.env.TEMP = originalTemp;
    }
  }
});

test("mention stage config disables shell access while keeping apply_patch enabled", async () => {
  const { configForStage } = await loadRunnerInternals();
  const config = configForStage("mention", sampleParams);

  assert.doesNotMatch(config, /shell_tool\s*=\s*true/);
  assert.match(config, /shell_tool\s*=\s*false/);
  assert.match(config, /apply_patch_freeform\s*=\s*true/);
  assert.match(config, /project_doc_max_bytes\s*=\s*0/);
});

test("Codex stage configs disable view_image to keep review runs on the readonly MCP surface", async () => {
  const { configForStage } = await loadRunnerInternals();

  for (const stage of ["reviewer", "editor", "verifier", "mention"] as const) {
    const config = configForStage(stage, { ...sampleParams, stage });
    assert.match(config, /\[tools\]/);
    assert.match(config, /view_image\s*=\s*false/);
  }
});

test("mention stage launch uses an isolated cwd instead of the repo checkout", async () => {
  const { buildStageLaunch } = await loadRunnerInternals();
  const launch = buildStageLaunch(sampleParams);

  assert.equal(launch.stageCwd, "/tmp/out");
  assert.equal(launch.codexArgs.includes("/tmp/repo"), true);
  assert.equal(launch.codexArgs.includes("/tmp/bundle"), true);
  assert.doesNotMatch(launch.fullPrompt, /current working directory is the repo root/i);
  assert.match(launch.fullPrompt, /absolute paths under \/tmp\/repo/i);
});
