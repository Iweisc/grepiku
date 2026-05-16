import fs from "fs/promises";
import path from "path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "url";
import { execa } from "execa";
import { loadEnv } from "../config/env.js";
import {
  runCodexStageInKubernetes,
  shouldUseKubernetesSandbox
} from "../sandbox/k8sRunner.js";

export type CodexStage = "reviewer" | "editor" | "verifier" | "mention";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type CodexRunParams = {
  stage: CodexStage;
  repoPath?: string;
  bundleDir: string;
  outDir: string;
  codexHomeDir: string;
  prompt: string;
  headSha: string;
  repoId: number;
  reviewRunId: number;
  prNumber: number;
  captureLastMessage?: boolean;
  reasoningEffort?: CodexReasoningEffort;
  executionMode?: "local" | "kubernetes-sandbox";
};

export type CodexTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type CodexStageMetrics = {
  stage: CodexStage;
  reasoningEffort: CodexReasoningEffort;
  durationMs: number;
  promptChars: number;
  promptBytes: number;
  estimatedPromptTokens: number;
  usage: CodexTokenUsage | null;
};

const env = loadEnv();
let resolvedCodexExecPath: string | null = null;
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGE_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "TERM",
  "TZ"
] as const;

function applyIsolatedHomeEnv(output: NodeJS.ProcessEnv, homeDir: string): NodeJS.ProcessEnv {
  output.HOME = homeDir;
  output.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  output.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  output.XDG_STATE_HOME = path.join(homeDir, ".state");
  const tempDir = path.join(homeDir, ".tmp");
  output.TMPDIR = tempDir;
  output.TMP = tempDir;
  output.TEMP = tempDir;
  return output;
}

function systemPrompt(stage: CodexStage, roots: string[]): string {
  const toolNote = (() => {
    if (stage === "verifier") return "Available tool names: read_file, search, lint, build, test.";
    if (stage === "mention") return "Available tool names: read_file, search, retrieve_context, apply_patch.";
    return "Available tool names: read_file, search, retrieve_context.";
  })();
  const writeInstruction =
    stage === "mention"
      ? `You may modify files under the repo root and write required outputs to the output root. The current working directory is not the repo checkout; when editing repository files, target absolute paths under ${roots[0]}.`
      : `Only write outputs to ${roots[roots.length - 1]} as instructed by the prompt. If no write-capable tool is available, return the required JSON as your final response instead; the runner captures it.`;
  const allowedRoots = roots.join(", ");
  return [
    "SYSTEM: You are a code-review agent running inside a sandboxed repo checkout.",
    "You must use tools and files correctly.",
    toolNote,
    `Allowed file roots: ${allowedRoots}.`,
    "Never access paths outside allowed roots.",
    "Use the listed tool names directly; do not refer to MCP server names.",
    "Do not call resource-listing or planning/todo tools unless the prompt explicitly asks for them.",
    "If a tool call fails due to ENOENT or bad path, correct the path and retry.",
    "Never fabricate file contents. Use tools to read files.",
    writeInstruction
  ].join("\n");
}

async function writeAuthFile(codexHomeDir: string): Promise<void> {
  const authPayload = JSON.stringify({ OPENAI_API_KEY: env.openaiApiKey }, null, 2);
  const codexAuthPath = path.join(codexHomeDir, "auth.json");
  await fs.writeFile(codexAuthPath, authPayload, { encoding: "utf8", mode: 0o600 });
}

export async function resolveCodexExecPath(): Promise<string> {
  if (resolvedCodexExecPath) return resolvedCodexExecPath;
  const candidates = Array.from(new Set([env.codexExecPath, "codex-exec"]));
  for (const candidate of candidates) {
    try {
      await execa(candidate, ["--version"], { stdio: "ignore" });
      resolvedCodexExecPath = candidate;
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `Unable to find codex-exec. Tried: ${candidates.join(", ")}. ` +
      `Set CODEX_EXEC_PATH or build it in internal_harness/codex-slim with: ` +
      `cargo build -p codex-exec --release --locked`
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function mcpScriptPath(scriptName: string): string {
  return path.join(runtimeRoot, "docker", "codex-runner", "tools", scriptName);
}

function tomlInlineTable(values: Record<string, string | undefined>): string | null {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, string] => Boolean(entry[1] && entry[1].trim().length > 0)
  );
  if (entries.length === 0) return null;
  return `{ ${entries.map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ")} }`;
}

function mcpServerBlock(
  name: string,
  scriptName: string,
  serverEnv: Record<string, string | undefined>,
  options?: { startupTimeoutSec?: number; toolTimeoutSec?: number }
): string {
  const startupTimeoutSec = options?.startupTimeoutSec ?? 10;
  const toolTimeoutSec = options?.toolTimeoutSec ?? 10;
  const envInline = tomlInlineTable(serverEnv);
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlString("node")}`,
    `args = [${tomlString(mcpScriptPath(scriptName))}]`,
    `startup_timeout_sec = ${startupTimeoutSec}`,
    `tool_timeout_sec = ${toolTimeoutSec}`
  ];
  if (envInline) {
    lines.push(`env = ${envInline}`);
  }
  lines.push("");
  return lines.join("\n");
}

function baseConfig(params?: {
  shellTool?: boolean;
  applyPatchFreeform?: boolean;
  reasoningEffort?: CodexReasoningEffort;
}): string {
  const shellTool = params?.shellTool === true;
  const applyPatchFreeform = params?.applyPatchFreeform === true;
  const reasoningEffort = params?.reasoningEffort ?? env.codexModelReasoningEffort;
  return [
    `approval_policy = "never"`,
    `sandbox_mode = "workspace-write"`,
    `web_search = "disabled"`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    `project_doc_max_bytes = 0`,
    "",
    "[features]",
    `shell_tool = ${shellTool ? "true" : "false"}`,
    `apply_patch_freeform = ${applyPatchFreeform ? "true" : "false"}`,
    "web_search_request = false",
    "web_search_cached = false",
    "",
    "[tools]",
    "view_image = false",
    ""
  ].join("\n");
}

function configForStage(stage: CodexStage, params: CodexRunParams): string {
  const runningInKubernetesSandbox = params.executionMode === "kubernetes-sandbox";
  const readonlyEnv = {
    WORK_REPO_ROOT: params.repoPath,
    WORK_BUNDLE_ROOT: params.bundleDir,
    WORK_OUT_ROOT: params.outDir
  };
  if (stage === "reviewer") {
    const base = baseConfig({ reasoningEffort: params.reasoningEffort });
    return (
      `${base}\n` +
      mcpServerBlock("readonly", "readonly_mcp.js", readonlyEnv) +
      mcpServerBlock(
        "retrieval",
        "retrieval_mcp.js",
        runningInKubernetesSandbox
          ? {
              RETRIEVAL_CONTEXT_PACK_PATH: path.join(params.bundleDir, "context_pack.json")
            }
          : {
              INTERNAL_API_URL: env.internalApiUrl,
              INTERNAL_API_KEY: env.internalApiKey,
              REVIEW_REPO_ID: String(params.repoId)
            }
      )
    );
  }
  if (stage === "editor") {
    const base = baseConfig({ reasoningEffort: params.reasoningEffort });
    return (
      `${base}\n` +
      mcpServerBlock("readonly", "readonly_mcp.js", readonlyEnv) +
      mcpServerBlock(
        "retrieval",
        "retrieval_mcp.js",
        runningInKubernetesSandbox
          ? {
              RETRIEVAL_CONTEXT_PACK_PATH: path.join(params.bundleDir, "context_pack.json")
            }
          : {
              INTERNAL_API_URL: env.internalApiUrl,
              INTERNAL_API_KEY: env.internalApiKey,
              REVIEW_REPO_ID: String(params.repoId)
            }
      )
    );
  }
  if (stage === "verifier") {
    const base = baseConfig({ reasoningEffort: params.reasoningEffort });
    const verifierToolTimeoutSec = Math.max(30, Math.ceil(env.codexStageTimeoutMs / 1000));
    return (
      `${base}\n` +
      mcpServerBlock("readonly", "readonly_mcp.js", readonlyEnv) +
      mcpServerBlock(
        "verifier",
        "verifier_mcp.js",
        runningInKubernetesSandbox
          ? {
              WORK_REPO_ROOT: params.repoPath,
              WORK_BUNDLE_ROOT: params.bundleDir,
              WORK_OUT_ROOT: params.outDir,
              VERIFIER_CACHE_DIR: path.join(params.outDir, ".verifier-cache"),
              VERIFIER_REPO_COMMAND_MODE: "direct",
              REVIEW_RUN_ID: String(params.reviewRunId)
            }
          : {
              WORK_REPO_ROOT: params.repoPath,
              WORK_BUNDLE_ROOT: params.bundleDir,
              WORK_OUT_ROOT: params.outDir,
              DATABASE_URL: env.databaseUrl,
              REVIEW_RUN_ID: String(params.reviewRunId)
            },
        { toolTimeoutSec: verifierToolTimeoutSec }
      )
    );
  }
  if (stage === "mention") {
    const base = baseConfig({ applyPatchFreeform: true, reasoningEffort: params.reasoningEffort });
    return (
      `${base}\n` +
      mcpServerBlock("readonly", "readonly_mcp.js", readonlyEnv) +
      mcpServerBlock(
        "retrieval",
        "retrieval_mcp.js",
        runningInKubernetesSandbox
          ? {
              RETRIEVAL_CONTEXT_PACK_PATH: path.join(params.bundleDir, "context_pack.json")
            }
          : {
              INTERNAL_API_URL: env.internalApiUrl,
              INTERNAL_API_KEY: env.internalApiKey,
              REVIEW_REPO_ID: String(params.repoId)
            }
      )
    );
  }
  return baseConfig();
}

function baseStageEnv(): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of STAGE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      output[key] = value;
    }
  }
  return output;
}

function buildStageEnv(params: CodexRunParams, stageHomeDir: string): NodeJS.ProcessEnv {
  return applyIsolatedHomeEnv({
    ...baseStageEnv(),
    OPENAI_BASE_URL: env.openaiBaseUrl,
    OPENAI_TIMEOUT_MS: String(env.openaiTimeoutMs),
    OPENAI_MAX_RETRIES: String(env.openaiMaxRetries),
    CODEX_HOME: stageHomeDir,
    CODEX_DISABLE_PROJECT_DOC: "1",
    CODEX_QUIET_MODE: "1"
  }, stageHomeDir);
}

function buildStageLaunch(params: CodexRunParams): {
  codexArgs: string[];
  fullPrompt: string;
  stageCwd: string;
} {
  const stageCwd = params.outDir;
  const codexArgs = [
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--model",
    env.openaiModel
  ];

  if (params.stage === "mention") {
    const extraReadableWritableRoots = Array.from(
      new Set(
        [params.repoPath, params.bundleDir]
          .filter((dir): dir is string => Boolean(dir && dir !== stageCwd))
      )
    );
    for (const dir of extraReadableWritableRoots) {
      codexArgs.push("--add-dir", dir);
    }
  }

  if (params.captureLastMessage !== false) {
    codexArgs.push("--output-last-message", path.join(params.outDir, `last_message_${params.stage}.txt`));
  }
  codexArgs.push("-");

  const roots = [params.repoPath, params.bundleDir, params.outDir].filter(
    (value): value is string => Boolean(value)
  );
  const fullPrompt = `${systemPrompt(params.stage, roots)}\n\n${params.prompt}`;

  return {
    codexArgs,
    fullPrompt,
    stageCwd
  };
}

function estimatePromptTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function parseCodexUsageLine(line: string): CodexTokenUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const event = parsed as { type?: unknown; usage?: unknown };
  if (event.type !== "turn.completed" || !event.usage || typeof event.usage !== "object") {
    return null;
  }
  const usage = event.usage as Record<string, unknown>;
  const inputTokens = Number(usage.input_tokens);
  const cachedInputTokens = Number(usage.cached_input_tokens);
  const outputTokens = Number(usage.output_tokens);
  if (![inputTokens, cachedInputTokens, outputTokens].every(Number.isFinite)) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens
  };
}

function forwardStageStream(params: {
  stream: NodeJS.ReadableStream | null | undefined;
  stageTag: string;
  channel: "stdout" | "stderr";
}): Promise<void> {
  if (!params.stream) return Promise.resolve();
  const log = params.channel === "stderr" ? console.error : console.log;
  const rl = createInterface({
    input: params.stream,
    crlfDelay: Infinity
  });
  rl.on("line", (line) => {
    if (line.length === 0) return;
    log(`${params.stageTag} ${params.channel}: ${line}`);
  });
  return new Promise((resolve, reject) => {
    rl.once("close", () => resolve());
    rl.once("error", reject);
  });
}

function scanCodexJsonStream(params: {
  stream: NodeJS.ReadableStream | null | undefined;
  stageTag: string;
  logLines: boolean;
  onUsage: (usage: CodexTokenUsage) => void;
}): Promise<void> {
  if (!params.stream) return Promise.resolve();
  const rl = createInterface({
    input: params.stream,
    crlfDelay: Infinity
  });
  rl.on("line", (line) => {
    if (line.length === 0) return;
    const usage = parseCodexUsageLine(line);
    if (usage) {
      params.onUsage(usage);
    }
    if (params.logLines) {
      console.log(`${params.stageTag} stdout: ${line}`);
    }
  });
  return new Promise((resolve, reject) => {
    rl.once("close", () => resolve());
    rl.once("error", reject);
  });
}

async function writeStageMetrics(params: {
  outDir: string;
  stage: CodexStage;
  startedAt: number;
  metrics: CodexStageMetrics;
}): Promise<void> {
  const safeStage = params.stage.replace(/[^a-z0-9_-]/gi, "_");
  const metricsPath = path.join(params.outDir, `stage_metrics_${safeStage}_${params.startedAt}.json`);
  const latestPath = path.join(params.outDir, `stage_metrics_latest_${safeStage}.json`);
  const raw = JSON.stringify(params.metrics, null, 2);
  await fs.writeFile(metricsPath, raw, "utf8");
  await fs.writeFile(latestPath, raw, "utf8");
}

function formatTokenUsageForLog(usage: CodexTokenUsage | null): string {
  if (!usage) return "";
  return ` tokens input=${usage.inputTokens} cached=${usage.cachedInputTokens} output=${usage.outputTokens}`;
}

export async function runCodexStage(params: CodexRunParams): Promise<CodexStageMetrics> {
  if (shouldUseKubernetesSandbox(env) && params.executionMode !== "kubernetes-sandbox") {
    return runCodexStageInKubernetes(params);
  }
  return runCodexStageLocal(params);
}

export async function runCodexStageLocal(params: CodexRunParams): Promise<CodexStageMetrics> {
  const stageTag = `[run ${params.reviewRunId} pr#${params.prNumber} ${params.stage}]`;
  const reasoningEffort = params.reasoningEffort ?? env.codexModelReasoningEffort;
  const codexExecPath = await resolveCodexExecPath();
  const stageHomeDir = path.join(params.codexHomeDir, params.stage);
  await fs.mkdir(stageHomeDir, { recursive: true });
  await fs.mkdir(path.join(stageHomeDir, ".tmp"), { recursive: true });
  await writeAuthFile(stageHomeDir);
  const configToml = configForStage(params.stage, params);
  const configPath = path.join(stageHomeDir, "config.toml");
  await fs.writeFile(configPath, configToml, "utf8");
  const stageEnv = buildStageEnv(params, stageHomeDir);
  const { codexArgs, fullPrompt, stageCwd } = buildStageLaunch(params);
  const startedAt = Date.now();
  const tokenUsageRef: { current: CodexTokenUsage | null } = { current: null };
  let forwarders: Promise<void>[] = [];
  console.log(`${stageTag} starting`);
  try {
    if (!env.codexStageLogOutput) {
      const subprocess = execa(codexExecPath, codexArgs, {
        input: fullPrompt,
        stdout: "pipe",
        stderr: "inherit",
        buffer: false,
        cwd: stageCwd,
        env: stageEnv,
        timeout: env.codexStageTimeoutMs,
        killSignal: "SIGTERM",
        forceKillAfterDelay: 10_000
      });
      forwarders = [
        scanCodexJsonStream({
          stream: subprocess.stdout,
          stageTag,
          logLines: false,
          onUsage: (usage) => {
            tokenUsageRef.current = usage;
          }
        })
      ];
      await subprocess;
      await Promise.allSettled(forwarders);
      const durationMs = Date.now() - startedAt;
      const metrics = {
        stage: params.stage,
        reasoningEffort,
        durationMs,
        promptChars: fullPrompt.length,
        promptBytes: Buffer.byteLength(fullPrompt, "utf8"),
        estimatedPromptTokens: estimatePromptTokens(fullPrompt),
        usage: tokenUsageRef.current
      };
      await writeStageMetrics({ outDir: params.outDir, stage: params.stage, startedAt, metrics });
      console.log(`${stageTag} completed in ${durationMs}ms${formatTokenUsageForLog(tokenUsageRef.current)}`);
      return metrics;
    }

    const subprocess = execa(codexExecPath, codexArgs, {
      input: fullPrompt,
      stdout: "pipe",
      stderr: "pipe",
      buffer: false,
      cwd: stageCwd,
      env: stageEnv,
      timeout: env.codexStageTimeoutMs,
      killSignal: "SIGTERM",
      forceKillAfterDelay: 10_000
    });

    forwarders = [
      scanCodexJsonStream({
        stream: subprocess.stdout,
        stageTag,
        logLines: true,
        onUsage: (usage) => {
          tokenUsageRef.current = usage;
        }
      }),
      forwardStageStream({
        stream: subprocess.stderr,
        stageTag,
        channel: "stderr"
      })
    ];

    await subprocess;
    await Promise.allSettled(forwarders);
    const durationMs = Date.now() - startedAt;
    const metrics = {
      stage: params.stage,
      reasoningEffort,
      durationMs,
      promptChars: fullPrompt.length,
      promptBytes: Buffer.byteLength(fullPrompt, "utf8"),
      estimatedPromptTokens: estimatePromptTokens(fullPrompt),
      usage: tokenUsageRef.current
    };
    await writeStageMetrics({ outDir: params.outDir, stage: params.stage, startedAt, metrics });
    console.log(`${stageTag} completed in ${durationMs}ms${formatTokenUsageForLog(tokenUsageRef.current)}`);
    return metrics;
  } catch (err) {
    if (forwarders.length > 0) {
      await Promise.allSettled(forwarders);
    }
    console.error(`${stageTag} failed in ${Date.now() - startedAt}ms`, err);
    throw err;
  }
}

export const __codexRunnerInternals = {
  buildStageEnv,
  configForStage,
  buildStageLaunch,
  estimatePromptTokens,
  parseCodexUsageLine
};
