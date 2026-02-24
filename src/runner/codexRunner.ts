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
let runnerImageReady = false;
let resolvedNetwork: string | null = null;

function systemPrompt(stage: CodexStage): string {
  const toolNote =
    stage === "verifier"
      ? "Tools available: readonly, verifier."
      : "Tools available: readonly, retrieval.";
  return [
    "SYSTEM: You are a code-review agent running inside a sandboxed repo checkout.",
    "You must use tools and files correctly.",
    toolNote,
    "Allowed file roots: /work/repo, /work/bundle, /work/out.",
    "Never access /work/src or other paths outside allowed roots.",
    "If a tool call fails due to ENOENT or bad path, correct the path and retry.",
    "Never fabricate file contents. Use tools to read files.",
    "Only write outputs to /work/out as instructed by the prompt."
  ].join("\n");
}

async function writeAuthFiles(codexHomeDir: string, outDir: string): Promise<string> {
  const authPayload = JSON.stringify({ OPENAI_API_KEY: env.openaiApiKey }, null, 2);
  const codexAuthPath = path.join(codexHomeDir, "auth.json");
  await fs.writeFile(codexAuthPath, authPayload, { encoding: "utf8", mode: 0o600 });

  const configDir = path.join(outDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  const configAuthPath = path.join(configDir, "auth.json");
  await fs.writeFile(configAuthPath, authPayload, { encoding: "utf8", mode: 0o600 });
  return configDir;
}

async function ensureRunnerImage(): Promise<void> {
  if (runnerImageReady) return;
  try {
    await execa("docker", ["image", "inspect", env.runnerImage], { stdio: "ignore" });
    runnerImageReady = true;
    return;
  } catch {
    if (!env.runnerAutobuild) {
      throw new Error(
        `Runner image ${env.runnerImage} not found. Build it once with: ` +
          `docker build -t ${env.runnerImage} -f docker/codex-runner/Dockerfile .`
      );
    }
    const dockerfile = path.join(env.projectRoot, "docker", "codex-runner", "Dockerfile");
    await execa(
      "docker",
      ["build", "-t", env.runnerImage, "-f", dockerfile, env.projectRoot],
      { stdio: "inherit" }
    );
    runnerImageReady = true;
  }
}

async function resolveRunnerNetwork(): Promise<string> {
  if (resolvedNetwork) return resolvedNetwork;
  let network = env.runnerNetwork;
  if (network === "auto") {
    const project = process.env.COMPOSE_PROJECT_NAME || path.basename(env.projectRoot);
    network = `${project}_default`;
  }
  try {
    await execa("docker", ["network", "inspect", network], { stdio: "ignore" });
  } catch {
    throw new Error(
      `Runner network ${network} not found. Set RUNNER_NETWORK to an existing docker network ` +
        `that can reach the postgres service (e.g. ${network}).`
    );
  }
  resolvedNetwork = network;
  return network;
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
    return (
      base +
      `\n[mcp_servers.readonly]\n` +
      `command = "node"\n` +
      `args = ["/opt/grepiku-tools/tools/readonly_mcp.js"]\n` +
      `startup_timeout_sec = 10\n` +
      `tool_timeout_sec = 10\n` +
      `\n[mcp_servers.retrieval]\n` +
      `command = "node"\n` +
      `args = ["/opt/grepiku-tools/tools/retrieval_mcp.js"]\n` +
      `startup_timeout_sec = 10\n` +
      `tool_timeout_sec = 10\n`
    );
  }
  if (stage === "editor") {
    return (
      base +
      `\n[mcp_servers.readonly]\n` +
      `command = "node"\n` +
      `args = ["/opt/grepiku-tools/tools/readonly_mcp.js"]\n` +
      `startup_timeout_sec = 10\n` +
      `tool_timeout_sec = 10\n` +
      `\n[mcp_servers.retrieval]\n` +
      `command = "node"\n` +
      `args = ["/opt/grepiku-tools/tools/retrieval_mcp.js"]\n` +
      `startup_timeout_sec = 10\n` +
      `tool_timeout_sec = 10\n`
    );
  }
  if (stage === "verifier") {
    return (
      base +
      `\n[mcp_servers.readonly]\n` +
      `command = "node"\n` +
      `args = ["/opt/grepiku-tools/tools/readonly_mcp.js"]\n` +
      `startup_timeout_sec = 10\n` +
      `tool_timeout_sec = 10\n` +
      `\n[mcp_servers.verifier]\n` +
      `command = "node"\n` +
      `args = ["/opt/grepiku-tools/tools/verifier_mcp.js"]\n` +
      `startup_timeout_sec = 10\n` +
      `tool_timeout_sec = 10\n`
    );
  }
  return base;
}

export async function runCodexStage(params: CodexRunParams): Promise<void> {
  await ensureRunnerImage();
  const runnerNetwork = await resolveRunnerNetwork();
  const configDir = await writeAuthFiles(params.codexHomeDir, params.outDir);
  const configToml = configForStage(params.stage);
  const configPath = path.join(params.codexHomeDir, "config.toml");
  await fs.writeFile(configPath, configToml, "utf8");

  const envFilePath = path.join(params.outDir, "runner.env");
  const envFile = [
    `OPENAI_BASE_URL=${env.openaiBaseUrl}`,
    `OPENAI_TIMEOUT_MS=${env.openaiTimeoutMs}`,
    `OPENAI_MAX_RETRIES=${env.openaiMaxRetries}`,
    `CODEX_HOME=/work/codex-home`,
    `CODEX_DISABLE_PROJECT_DOC=1`,
    `CODEX_QUIET_MODE=1`,
    `DATABASE_URL=${env.databaseUrl}`,
    `REVIEW_RUN_ID=${params.reviewRunId}`,
    `REVIEW_REPO_ID=${params.repoId}`,
    `TOOLRUN_PR_NUMBER=${params.prNumber}`,
    `TOOLRUN_HEAD_SHA=${params.headSha}`,
    `INTERNAL_API_URL=http://web:3000/internal/retrieval`,
    `INTERNAL_API_KEY=${env.internalApiKey}`
  ].join("\n");
  await fs.writeFile(envFilePath, envFile, { encoding: "utf8", mode: 0o600 });

  const args: string[] = [
    "run",
    "--rm",
    "-i",
    "--network",
    runnerNetwork,
    "--env-file",
    envFilePath,
    "-v",
    `${params.bundleDir}:/work/bundle:ro`,
    "-v",
    `${params.outDir}:/work/out`,
    "-v",
    `${params.codexHomeDir}:/work/codex-home`
  ];

  if (params.repoPath) {
    args.push("-v", `${params.repoPath}:/work/repo:ro`);
  }

  args.push("-v", `${configDir}:/root/.config:ro`);

  args.push(
    env.runnerImage,
    "codex-exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--model",
    env.openaiModel,
    "--output-last-message",
    "/work/out/last_message.txt"
  );

  args.push("-");

  const fullPrompt = `${systemPrompt(params.stage)}\n\n${params.prompt}`;

  await execa("docker", args, {
    input: fullPrompt,
    stdio: "inherit"
  });
}
