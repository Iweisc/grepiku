import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

async function loadDirectRunnerInternals() {
  const module = await import("../src/runner/directModelRunner.js");
  return module.__directModelRunnerInternals;
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

test("Codex stage config can lower reasoning effort for targeted reviewer chunks", async () => {
  const { configForStage } = await loadRunnerInternals();
  const config = configForStage("reviewer", {
    ...sampleParams,
    stage: "reviewer" as const,
    reasoningEffort: "medium" as const
  });

  assert.match(config, /model_reasoning_effort\s*=\s*"medium"/);
});

test("Kubernetes sandbox stage config uses local caches instead of backend secrets", async () => {
  const { configForStage } = await loadRunnerInternals();
  const reviewerConfig = configForStage("reviewer", {
    ...sampleParams,
    stage: "reviewer" as const,
    executionMode: "kubernetes-sandbox" as const
  });
  const verifierConfig = configForStage("verifier", {
    ...sampleParams,
    stage: "verifier" as const,
    executionMode: "kubernetes-sandbox" as const
  });

  assert.match(reviewerConfig, /RETRIEVAL_CONTEXT_PACK_PATH/);
  assert.doesNotMatch(reviewerConfig, /INTERNAL_API_KEY/);
  assert.match(verifierConfig, /VERIFIER_CACHE_DIR/);
  assert.doesNotMatch(verifierConfig, /VERIFIER_REPO_COMMAND_MODE/);
  assert.doesNotMatch(verifierConfig, /DATABASE_URL/);
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

test("readonly stages can return captured JSON when file writes are unavailable", async () => {
  const { buildStageLaunch } = await loadRunnerInternals();
  const launch = buildStageLaunch({ ...sampleParams, stage: "editor" as const });

  assert.match(launch.fullPrompt, /If no write-capable tool is available/i);
  assert.match(launch.fullPrompt, /return the required JSON as your final response/i);
});

test("parseCodexUsageLine extracts turn token usage", async () => {
  const { parseCodexUsageLine } = await loadRunnerInternals();
  const usage = parseCodexUsageLine(
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 1200,
        cached_input_tokens: 300,
        output_tokens: 45
      }
    })
  );

  assert.deepEqual(usage, {
    inputTokens: 1200,
    cachedInputTokens: 300,
    outputTokens: 45
  });
});

test("parseCodexUsageLine ignores non-usage JSONL events", async () => {
  const { parseCodexUsageLine } = await loadRunnerInternals();

  assert.equal(parseCodexUsageLine("{not json"), null);
  assert.equal(parseCodexUsageLine(JSON.stringify({ type: "turn.started" })), null);
  assert.equal(
    parseCodexUsageLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: "nan", cached_input_tokens: 0, output_tokens: 10 }
      })
    ),
    null
  );
});

test("estimatePromptTokens uses byte-based estimate", async () => {
  const { estimatePromptTokens } = await loadRunnerInternals();

  assert.equal(estimatePromptTokens(""), 0);
  assert.equal(estimatePromptTokens("abcd"), 1);
  assert.equal(estimatePromptTokens("abcde"), 2);
});

test("direct model runner extracts text content and usage metrics", async () => {
  const { extractContent, usageFromResponse, estimatePromptTokens, isRetryableHttpStatus, retryDelayMs } =
    await loadDirectRunnerInternals();

  assert.equal(
    extractContent({
      choices: [{ message: { content: [{ type: "text", text: "{" }, { type: "text", text: "}" }] } }]
    }),
    "{}"
  );
  assert.deepEqual(
    usageFromResponse({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 }
      }
    }),
    {
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20
    }
  );
  assert.equal(usageFromResponse({ usage: { prompt_tokens: undefined, completion_tokens: 1 } }), null);
  assert.equal(estimatePromptTokens("abcdefgh"), 2);
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(retryDelayMs(4), 8000);
});

test("direct model runner retries empty successful responses", async () => {
  ensureRunnerTestEnv();
  const { runDirectModelStage } = await import("../src/runner/directModelRunner.js");
  const originalFetch = globalThis.fetch;
  const outDir = await mkdtemp(path.join(os.tmpdir(), "grepiku-direct-runner-"));
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      const body =
        calls === 1
          ? { choices: [{ message: { content: "" } }] }
          : {
              choices: [{ message: { content: "{}" } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 }
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const metrics = await runDirectModelStage({
      stage: "reviewer",
      outDir,
      prompt: "Return {}",
      reviewRunId: 1,
      prNumber: 2,
      reasoningEffort: "low",
      outputFileName: "draft_review.json"
    });

    assert.equal(calls, 2);
    assert.equal(await readFile(path.join(outDir, "draft_review.json"), "utf8"), "{}");
    assert.equal(metrics.usage?.inputTokens, 12);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(outDir, { recursive: true, force: true });
  }
});
