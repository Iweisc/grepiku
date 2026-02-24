import { createInterface } from "readline";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

const repoRoot = "/work/repo";
const bundleRoot = "/work/bundle";
const outRoot = "/work/out";
const searchRoots = [repoRoot, bundleRoot];
const readRoots = [repoRoot, bundleRoot, outRoot];

const tools = [
  {
    name: "read_file",
    description: "Read a file from the repo or bundle (JSON/text outputs allowed).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_bytes: { type: "integer" }
      },
      required: ["path"]
    }
  },
  {
    name: "search",
    description: "Search text in the repo.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        max_results: { type: "integer" }
      },
      required: ["query"]
    }
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

function resolveAllowedPath(inputPath, roots) {
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(repoRoot, inputPath);
  const isAllowed = roots.some((root) => resolved.startsWith(root));
  if (!isAllowed) {
    throw new Error("Path escapes allowed roots");
  }
  return resolved;
}

async function handleReadFile(args) {
  const target = resolveAllowedPath(args.path, readRoots);
  if (target.startsWith(outRoot)) {
    const isAllowedOutput =
      target.endsWith(".json") || target.endsWith(".txt");
    if (!isAllowedOutput) {
      throw new Error("Path not allowed in output dir");
    }
  }
  const maxBytes = Number.isInteger(args.max_bytes) ? args.max_bytes : 20000;
  const data = await fs.readFile(target);
  const sliced = data.slice(0, maxBytes).toString("utf8");
  return asText(sliced);
}

async function runRipgrep(args) {
  const query = args.query;
  const maxResults = Number.isInteger(args.max_results) ? args.max_results : 50;
  const searchRoot = args.path ? resolveAllowedPath(args.path, searchRoots) : repoRoot;

  const rgArgs = ["--no-heading", "--line-number", "--color", "never", query, searchRoot];
  if (args.glob) {
    rgArgs.splice(0, 0, "--glob", args.glob);
  }

  const proc = spawn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (d) => {
    stdout += d.toString("utf8");
  });
  proc.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });

  const code = await new Promise((resolve) => proc.on("close", resolve));
  if (code !== 0 && stdout.trim().length === 0) {
    return asText(stderr.trim() || "No matches");
  }

  const lines = stdout.trim().split("\n").filter(Boolean).slice(0, maxResults);
  return asText(lines.join("\n"));
}

const rl = createInterface({ input: process.stdin });
let protocolVersion = "1.0";

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    return;
  }

  if (!msg.method) return;

  try {
    if (msg.method === "initialize") {
      protocolVersion = msg.params?.protocolVersion || protocolVersion;
      sendResult(msg.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "grepiku-readonly", version: "0.1.0" }
      });
      return;
    }

    if (msg.method === "tools/list") {
      sendResult(msg.id, { tools });
      return;
    }

    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (name === "read_file") {
        const result = await handleReadFile(args);
        sendResult(msg.id, result);
        return;
      }
      if (name === "search") {
        const result = await runRipgrep(args);
        sendResult(msg.id, result);
        return;
      }
      sendError(msg.id, -32602, `Unknown tool: ${name}`);
      return;
    }

    if (msg.method === "shutdown") {
      sendResult(msg.id, null);
      return;
    }

    if (msg.method === "exit") {
      process.exit(0);
    }
  } catch (err) {
    sendError(msg.id, -32000, err?.message || "Tool error");
  }
});
