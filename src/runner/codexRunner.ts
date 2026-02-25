import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { loadEnv } from "../config/env.js";

export type CodexStage = "reviewer" | "editor" | "verifier";

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
};

const env = loadEnv();
let resolvedCodexExecPath: string | null = null;

function systemPrompt(stage: CodexStage, roots: string[]): string {
  const toolNote =
    stage === "verifier"
      ? "Tools available: readonly, verifier."
      : "Tools available: readonly, retrieval.";
  const allowedRoots = roots.join(", ");
  return [
    "SYSTEM: You are a code-review agent running inside a sandboxed repo checkout.",
    "You must use tools and files correctly.",
    toolNote,
    `Allowed file roots: ${allowedRoots}.`,
    "Never access paths outside allowed roots.",
    "If a tool call fails due to ENOENT or bad path, correct the path and retry.",
    "Never fabricate file contents. Use tools to read files.",
    `Only write outputs to ${roots[roots.length - 1]} as instructed by the prompt.`
  ].join("\n");
}

async function writeAuthFile(codexHomeDir: string): Promise<void> {
  const authPayload = JSON.stringify({ OPENAI_API_KEY: env.openaiApiKey }, null, 2);
  const codexAuthPath = path.join(codexHomeDir, "auth.json");
  await fs.writeFile(codexAuthPath, authPayload, { encoding: "utf8", mode: 0o600 });
}

async function resolveCodexExecPath(): Promise<string> {
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
  return path.join(env.projectRoot, "docker", "codex-runner", "tools", scriptName);
}

function mcpServerBlock(name: string, scriptName: string): string {
  return [
    `[mcp_servers.${name}]`,
    `command = ${tomlString("node")}`,
    `args = [${tomlString(mcpScriptPath(scriptName))}]`,
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 10",
    ""
  ].join("\n");
}

function configForStage(stage: CodexStage): string {
  const base = [
    `approval_policy = "never"`,
    `sandbox_mode = "workspace-write"`,
    `web_search = "disabled"`,
    `model_reasoning_effort = "high"`,
    "",
    "[features]",
    "shell_tool = false",
    "apply_patch_freeform = false",
    "web_search_request = false",
    "web_search_cached = false",
    ""
  ].join("\n");
  if (stage === "reviewer") {
    return `${base}\n${mcpServerBlock("readonly", "readonly_mcp.js")}${mcpServerBlock("retrieval", "retrieval_mcp.js")}`;
  }
  if (stage === "editor") {
    return `${base}\n${mcpServerBlock("readonly", "readonly_mcp.js")}${mcpServerBlock("retrieval", "retrieval_mcp.js")}`;
  }
  if (stage === "verifier") {
    return `${base}\n${mcpServerBlock("readonly", "readonly_mcp.js")}${mcpServerBlock("verifier", "verifier_mcp.js")}`;
  }
  return base;
}

export async function runCodexStage(params: CodexRunParams): Promise<void> {
  const codexExecPath = await resolveCodexExecPath();
  const stageHomeDir = path.join(params.codexHomeDir, params.stage);
  await fs.mkdir(stageHomeDir, { recursive: true });
  await writeAuthFile(stageHomeDir);
  const configToml = configForStage(params.stage);
  const configPath = path.join(stageHomeDir, "config.toml");
  await fs.writeFile(configPath, configToml, "utf8");
  const codexArgs = [
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--model",
    env.openaiModel,
    "--output-last-message",
    path.join(params.outDir, `last_message_${params.stage}.txt`),
    "-"
  ];

  const stageEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENAI_BASE_URL: env.openaiBaseUrl,
    OPENAI_TIMEOUT_MS: String(env.openaiTimeoutMs),
    OPENAI_MAX_RETRIES: String(env.openaiMaxRetries),
    CODEX_HOME: stageHomeDir,
    CODEX_DISABLE_PROJECT_DOC: "1",
    CODEX_QUIET_MODE: "1",
    DATABASE_URL: env.databaseUrl,
    REVIEW_RUN_ID: String(params.reviewRunId),
    REVIEW_REPO_ID: String(params.repoId),
    TOOLRUN_PR_NUMBER: String(params.prNumber),
    TOOLRUN_HEAD_SHA: params.headSha,
    INTERNAL_API_URL: env.internalApiUrl,
    INTERNAL_API_KEY: env.internalApiKey,
    WORK_BUNDLE_ROOT: params.bundleDir,
    WORK_OUT_ROOT: params.outDir
  };
  if (params.repoPath) {
    stageEnv.WORK_REPO_ROOT = params.repoPath;
  }

  const roots = [params.repoPath, params.bundleDir, params.outDir].filter(
    (value): value is string => Boolean(value)
  );
  const fullPrompt = `${systemPrompt(params.stage, roots)}\n\n${params.prompt}`;

  await execa(codexExecPath, codexArgs, {
    input: fullPrompt,
    stdio: "inherit",
    cwd: env.projectRoot,
    env: stageEnv
  });
}
