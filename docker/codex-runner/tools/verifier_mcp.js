import { createInterface } from "readline";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import pg from "pg";

const repoRoot = "/work/repo";
const outRoot = "/work/out";
const repoRw = path.join(outRoot, "repo_rw");

const tools = [
  {
    name: "lint",
    description: "Run lint command configured in .prreviewer.yml",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "build",
    description: "Run build command configured in .prreviewer.yml",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "test",
    description: "Run test command configured in .prreviewer.yml",
    inputSchema: { type: "object", properties: {}, required: [] }
  }
];

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

async function loadRepoConfig() {
  const configPath = path.join(repoRoot, ".prreviewer.yml");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = (yaml.load(raw) || {}) as any;
    return parsed;
  } catch (err) {
    return {};
  }
}

async function ensureRepoWritable() {
  try {
    await fs.stat(repoRw);
    return;
  } catch {}
  await fs.mkdir(repoRw, { recursive: true });
  await new Promise((resolve, reject) => {
    const proc = spawn("cp", ["-a", `${repoRoot}/.`, repoRw], { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve(null);
      else reject(new Error(`cp failed with ${code}`));
    });
  });
}

async function runCommand(cmd, timeoutSec, toolName) {
  await ensureRepoWritable();
  const logPath = path.join(outRoot, `tool-${toolName}.log`);
  const child = spawn(cmd, { shell: true, cwd: repoRw });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (d) => {
    stdout += d.toString("utf8");
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
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
  await fs.writeFile(logPath, stdout + "\n" + stderr, "utf8");

  if (timedOut) {
    return { status: "timeout", summary: "Timed out", topErrors: stderr.split("\n").slice(0, 10), logPath };
  }

  const exitCode = child.exitCode ?? 1;
  const topErrors = stderr.split("\n").filter(Boolean).slice(0, 10);
  if (exitCode === 0) {
    return { status: "pass", summary: "Success", topErrors, logPath };
  }

  return { status: "fail", summary: `Exited with ${exitCode}`, topErrors, logPath };
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function lookupToolRun(tool) {
  const repoInstallationId = Number(process.env.TOOLRUN_REPO_INSTALLATION_ID || 0);
  const prNumber = Number(process.env.TOOLRUN_PR_NUMBER || 0);
  const headSha = process.env.TOOLRUN_HEAD_SHA || "";
  const res = await client.query(
    'SELECT status, summary, "topErrors", "logPath" FROM "ToolRun" WHERE "repoInstallationId"=$1 AND "prNumber"=$2 AND "headSha"=$3 AND tool=$4',
    [repoInstallationId, prNumber, headSha, tool]
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
  const repoInstallationId = Number(process.env.TOOLRUN_REPO_INSTALLATION_ID || 0);
  const prNumber = Number(process.env.TOOLRUN_PR_NUMBER || 0);
  const headSha = process.env.TOOLRUN_HEAD_SHA || "";
  await client.query(
    'INSERT INTO "ToolRun" ("repoInstallationId", "prNumber", "headSha", tool, status, summary, "topErrors", "logPath", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now()) ON CONFLICT ("repoInstallationId","prNumber","headSha",tool) DO UPDATE SET status=EXCLUDED.status, summary=EXCLUDED.summary, "topErrors"=EXCLUDED."topErrors", "logPath"=EXCLUDED."logPath", "updatedAt"=now()',
    [
      repoInstallationId,
      prNumber,
      headSha,
      tool,
      result.status,
      result.summary,
      JSON.stringify(result.topErrors || []),
      result.logPath || null
    ]
  );
}

async function handleTool(toolName) {
  const cached = await lookupToolRun(toolName);
  if (cached) {
    return asText(JSON.stringify({
      status: cached.status,
      summary: cached.summary,
      top_errors: cached.topErrors || []
    }));
  }

  const repoConfig = await loadRepoConfig();
  const toolCfg = repoConfig?.tools?.[toolName];
  if (!toolCfg || !toolCfg.cmd) {
    const result = { status: "skipped", summary: "not configured", topErrors: [], logPath: null };
    await upsertToolRun(toolName, result);
    return asText(JSON.stringify({ status: result.status, summary: result.summary, top_errors: [] }));
  }

  const timeoutSec = toolCfg.timeout_sec || 600;
  const result = await runCommand(toolCfg.cmd, timeoutSec, toolName);
  await upsertToolRun(toolName, result);
  return asText(JSON.stringify({
    status: result.status,
    summary: result.summary,
    top_errors: result.topErrors || []
  }));
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
      await client.end();
      process.exit(0);
    }
  } catch (err) {
    sendError(msg.id, -32000, err?.message || "Tool error");
  }
});
