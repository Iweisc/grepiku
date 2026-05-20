import { createInterface } from "readline";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import pg from "pg";
import { loadTrustedVerifierTools } from "./config_io.js";
import {
  assertWorkspaceHasNoExternalSymlinks,
  buildIsolatedRepoCloneArgs,
  buildRepoCommandEnv,
  buildSandboxedRepoCommandInvocation,
  buildRepoCommandWorkspacePaths,
  createSerializedToolRunner,
  gitCheckoutSafetyEnv
} from "./exec_env.js";
import { buildVerifierToolResult } from "./repo_command_result.js";

const repoRoot = path.resolve(process.env.WORK_REPO_ROOT || "/work/repo");
const bundleRoot = path.resolve(process.env.WORK_BUNDLE_ROOT || "/work/bundle");
const outRoot = path.resolve(process.env.WORK_OUT_ROOT || "/work/out");
const workspacePaths = buildRepoCommandWorkspacePaths(outRoot);
const repoRw = workspacePaths.repoPath;
const repoCommandHome = workspacePaths.homeDir;
const verifierCacheDir = process.env.VERIFIER_CACHE_DIR
  ? path.resolve(process.env.VERIFIER_CACHE_DIR)
  : "";
const directRepoCommandMode = process.env.VERIFIER_REPO_COMMAND_MODE === "direct";

const tools = [
  {
    name: "lint",
    description: "Run the trusted bundled lint command for this review run",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "build",
    description: "Run the trusted bundled build command for this review run",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "test",
    description: "Run the trusted bundled test command for this review run",
    inputSchema: { type: "object", properties: {}, required: [] }
  }
];
const runVerifierToolExclusive = createSerializedToolRunner();

function sendResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}

function asText(text) {
  return { content: [{ type: "text", text }] };
}

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyRepoTreeWithoutGit() {
  await fs.mkdir(workspacePaths.stateRoot, { recursive: true });
  await fs.rm(repoRw, { recursive: true, force: true }).catch(() => undefined);
  await fs.cp(repoRoot, repoRw, {
    recursive: true,
    force: true,
    dereference: false,
    errorOnExist: false,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  await fs.rm(path.join(repoRw, ".git"), { recursive: true, force: true }).catch(() => undefined);
  await assertWorkspaceHasNoExternalSymlinks(repoRw, "verifier workspace");
}

async function ensureRepoWritable() {
  if (directRepoCommandMode || !(await pathExists(path.join(repoRoot, ".git")))) {
    await copyRepoTreeWithoutGit();
    return;
  }
  try {
    await fs.stat(repoRw);
    await assertWorkspaceHasNoExternalSymlinks(repoRw, "verifier workspace");
    return;
  } catch {}
  await fs.mkdir(workspacePaths.stateRoot, { recursive: true });
  const { stdout: sourceHeadSha } = await new Promise((resolve, reject) => {
    const proc = spawn("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      env: gitCheckoutSafetyEnv(process.env),
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`git rev-parse failed with ${code}`));
    });
  });

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn("git", buildIsolatedRepoCloneArgs(repoRoot, repoRw), {
        env: gitCheckoutSafetyEnv(),
        stdio: "inherit"
      });
      proc.on("close", (code) => {
        if (code === 0) resolve(null);
        else reject(new Error(`git clone failed with ${code}`));
      });
    });
    await new Promise((resolve, reject) => {
      const proc = spawn(
        "git",
        ["-C", repoRw, "checkout", "--quiet", "--detach", sourceHeadSha.trim()],
        { env: gitCheckoutSafetyEnv(), stdio: "inherit" }
      );
      proc.on("close", (code) => {
        if (code === 0) resolve(null);
        else reject(new Error(`git checkout failed with ${code}`));
      });
    });
    await assertWorkspaceHasNoExternalSymlinks(repoRw, "verifier workspace");
  } catch (error) {
    await fs.rm(repoRw, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function runCommand(cmd, timeoutSec, toolName) {
  await ensureRepoWritable();
  await fs.mkdir(repoCommandHome, { recursive: true });
  const commandEnv = buildRepoCommandEnv(process.env, { homeDir: repoCommandHome });
  if (commandEnv.TMPDIR) {
    await fs.mkdir(commandEnv.TMPDIR, { recursive: true });
  }
  await assertWorkspaceHasNoExternalSymlinks(repoCommandHome, "verifier tool home");
  const invocation = directRepoCommandMode
    ? {
        file: "/bin/sh",
        args: ["-lc", cmd],
        options: {
          cwd: repoRw,
          env: commandEnv,
          shell: false
        }
      }
    : buildSandboxedRepoCommandInvocation({
        codexExecPath: process.env.CODEX_EXEC_PATH || "codex-exec",
        repoPath: repoRw,
        homeDir: repoCommandHome,
        command: cmd,
        env: commandEnv
      });
  const child = spawn(invocation.file, invocation.args, {
    ...invocation.options,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let hadStderr = false;

  child.stderr.on("data", () => {
    hadStderr = true;
  });

  let timeoutHandle;
  const timedOut = await new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(true), timeoutSec * 1000);
    child.on("close", () => resolve(false));
  });

  if (timedOut) {
    child.kill("SIGKILL");
  }

  clearTimeout(timeoutHandle);
  return buildVerifierToolResult({
    exitCode: child.exitCode,
    timedOut,
    hadStderr
  });
}

const client = process.env.DATABASE_URL
  ? new pg.Client({ connectionString: process.env.DATABASE_URL })
  : null;
if (client) {
  await client.connect();
}

async function cacheFileForTool(tool) {
  if (!verifierCacheDir) return null;
  await fs.mkdir(verifierCacheDir, { recursive: true });
  return path.join(verifierCacheDir, `${tool.replace(/[^a-z0-9_-]/gi, "_")}.json`);
}

async function lookupToolRun(tool) {
  const cachePath = await cacheFileForTool(tool);
  if (cachePath) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
      return {
        status: cached.status,
        summary: cached.summary,
        topErrors: cached.topErrors || cached.top_errors || [],
        logPath: cached.logPath || null
      };
    } catch {
      return null;
    }
  }
  if (!client) return null;
  const reviewRunId = Number(process.env.REVIEW_RUN_ID || 0);
  const res = await client.query(
    'SELECT status, summary, "topErrors", "logPath" FROM "ToolRun" WHERE "reviewRunId"=$1 AND tool=$2',
    [reviewRunId, tool]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  let topErrors = row.topErrors || [];
  if (typeof topErrors === "string") {
    try {
      topErrors = JSON.parse(topErrors);
    } catch {
      topErrors = [];
    }
  }
  return { ...row, topErrors };
}

async function upsertToolRun(tool, result) {
  const cachePath = await cacheFileForTool(tool);
  if (cachePath) {
    await fs.writeFile(cachePath, JSON.stringify(result, null, 2), "utf8");
    return;
  }
  if (!client) return;
  const reviewRunId = Number(process.env.REVIEW_RUN_ID || 0);
  const topErrors = result.top_errors || result.topErrors || [];
  const logPath = result.log_path ?? result.logPath ?? null;
  await client.query(
    'INSERT INTO "ToolRun" ("reviewRunId", tool, status, summary, "topErrors", "logPath", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now(),now()) ON CONFLICT ("reviewRunId",tool) DO UPDATE SET status=EXCLUDED.status, summary=EXCLUDED.summary, "topErrors"=EXCLUDED."topErrors", "logPath"=EXCLUDED."logPath", "updatedAt"=now()',
    [reviewRunId, tool, result.status, result.summary, JSON.stringify(topErrors), logPath]
  );
}

async function handleTool(toolName) {
  return await runVerifierToolExclusive(async () => {
    const cached = await lookupToolRun(toolName);
    if (cached) {
      return asText(JSON.stringify({
        status: cached.status,
        summary: cached.summary,
        top_errors: cached.topErrors || []
      }));
    }

    const trustedTools = await loadTrustedVerifierTools({ bundleRoot, repoRoot });
    const toolCfg = trustedTools[toolName];
    if (!toolCfg || !toolCfg.cmd) {
      const result = { status: "skipped", summary: "not configured", top_errors: [], log_path: null };
      await upsertToolRun(toolName, result);
      return asText(JSON.stringify({ status: result.status, summary: result.summary, top_errors: [] }));
    }

    const timeoutSec = toolCfg.timeout_sec || 600;
    const result = await runCommand(toolCfg.cmd, timeoutSec, toolName);
    await upsertToolRun(toolName, result);
    return asText(JSON.stringify({
      status: result.status,
      summary: result.summary,
      top_errors: result.top_errors || []
    }));
  });
}

const rl = createInterface({ input: process.stdin });
let protocolVersion = "1.0";

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (!msg.method) return;

  try {
    if (msg.method === "initialize") {
      protocolVersion = msg.params?.protocolVersion || protocolVersion;
      sendResult(msg.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "grepiku-verifier", version: "0.1.0" }
      });
      return;
    }

    if (msg.method === "tools/list") {
      sendResult(msg.id, { tools });
      return;
    }

    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      if (!name) {
        sendError(msg.id, -32602, "Missing tool name");
        return;
      }
      if (!tools.find((t) => t.name === name)) {
        sendError(msg.id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const result = await handleTool(name);
      sendResult(msg.id, result);
      return;
    }

    if (msg.method === "shutdown") {
      sendResult(msg.id, null);
      return;
    }

    if (msg.method === "exit") {
      if (client) await client.end();
      process.exit(0);
    }
  } catch (err) {
    sendError(msg.id, -32000, err?.message || "Tool error");
  }
});
