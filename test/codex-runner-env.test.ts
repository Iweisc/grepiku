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

test("agentic reviewer config enables shell without retrieval MCP and restricts writes to output", async () => {
  const { configForStage } = await loadRunnerInternals();
  const config = configForStage("reviewer", {
    ...sampleParams,
    stage: "reviewer" as const,
    reviewerMode: "agentic" as const,
    reasoningEffort: "low" as const
  });

  assert.match(config, /shell_tool\s*=\s*true/);
  assert.doesNotMatch(config, /mcp_servers\.retrieval/);
  assert.match(config, /writable_roots\s*=\s*\["\/tmp\/out"\]/);
  assert.match(config, /network_access\s*=\s*false/);
});

test("agentic tool wrappers fall back to source entrypoints when dist is unavailable", async () => {
  const { writeAgenticToolWrappers } = await loadRunnerInternals();
  const root = await mkdtemp(path.join(os.tmpdir(), "grepiku-agentic-wrappers-"));
  try {
    await writeAgenticToolWrappers(root);
    const gr = await readFile(path.join(root, "agentic-bin", "gr"), "utf8");
    const git = await readFile(path.join(root, "agentic-bin", "git"), "utf8");
    assert.ok((gr.includes("dist/tools/gr.js") && gr.includes("node ")) || (gr.includes("node_modules/.bin/tsx") && gr.includes("src/tools/gr.ts")));
    assert.match(git, /readOnlyGit\.(ts|js)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agentic reviewer env prepends gr and git wrapper path and hardens pagers", async () => {
  const { buildStageEnv } = await loadRunnerInternals();
  const env = buildStageEnv(
    { ...sampleParams, stage: "reviewer" as const, reviewerMode: "agentic" as const },
    "/tmp/codex-home/reviewer"
  );

  assert.equal(env.PATH?.split(path.delimiter)[0], "/tmp/codex-home/reviewer/agentic-bin");
  assert.equal(env.GREPIKU_GIT_WRAPPER_DIR, "/tmp/codex-home/reviewer/agentic-bin");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.PAGER, "cat");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.WORK_REPO_ROOT, "/tmp/repo");
  assert.equal(env.GREPIKU_CONTEXT_PACK_PATH, "/tmp/bundle/context_pack.json");
});

test("agentic reviewer prompt names shell inspection and gr", async () => {
  const { buildStageLaunch } = await loadRunnerInternals();
  const launch = buildStageLaunch({
    ...sampleParams,
    stage: "reviewer" as const,
    reviewerMode: "agentic" as const,
    prompt: "Run gr --help"
  });

  assert.match(launch.fullPrompt, /shell_command/);
  assert.match(launch.fullPrompt, /gr only for Grepiku-specific context/);
});

test("agentic metrics scanner captures shell and gr usage", async () => {
  const { createAgenticUsageAccumulator, scanAgenticUsageLine, finalizeAgenticUsage } = await loadRunnerInternals();
  const acc = createAgenticUsageAccumulator();
  scanAgenticUsageLine(
    JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({ command: "gr retrieve auth --top-k 3 && git diff HEAD -- src/app.ts && sed -n '1,20p' src/app.ts" })
      }
    }),
    acc
  );
  const metrics = finalizeAgenticUsage(acc);

  assert.equal(metrics.retrievalCalls, 1);
  assert.deepEqual(metrics.grCommands, ["gr retrieve auth --top-k 3"]);
  assert.equal(metrics.filesInspected.includes("src/app.ts"), true);
});

test("agentic metrics scanner counts changed-context as retrieval usage", async () => {
  const { createAgenticUsageAccumulator, scanAgenticUsageLine, finalizeAgenticUsage } = await loadRunnerInternals();
  const acc = createAgenticUsageAccumulator();
  scanAgenticUsageLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "gr changed-context --top-k 8 --json && gr risk --path src/app.ts",
        exit_code: 0
      }
    }),
    acc
  );
  const metrics = finalizeAgenticUsage(acc);

  assert.equal(metrics.retrievalCalls, 1);
  assert.equal(metrics.grCommands.includes("gr changed-context --top-k 8 --json"), true);
});

test("agentic metrics scanner captures codex exec_command payload events", async () => {
  const { createAgenticUsageAccumulator, scanAgenticUsageLine, finalizeAgenticUsage } = await loadRunnerInternals();
  const acc = createAgenticUsageAccumulator();
  scanAgenticUsageLine(
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "gr rules --path src/app.ts --json && git diff HEAD -- src/app.ts" })
      }
    }),
    acc
  );
  const metrics = finalizeAgenticUsage(acc);

  assert.equal(metrics.grCommands.includes("gr rules --path src/app.ts --json"), true);
  assert.equal(metrics.filesInspected.includes("src/app.ts"), true);
});

test("agentic metrics scanner captures command_execution item events", async () => {
  const { createAgenticUsageAccumulator, scanAgenticUsageLine, finalizeAgenticUsage } = await loadRunnerInternals();
  const acc = createAgenticUsageAccumulator();
  scanAgenticUsageLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "gr --help && sed -n '1,20p' src/app.ts",
        exit_code: 0
      }
    }),
    acc
  );
  const metrics = finalizeAgenticUsage(acc);

  assert.equal(metrics.grCommands.includes("gr --help"), true);
  assert.equal(metrics.filesInspected.includes("src/app.ts"), true);
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
