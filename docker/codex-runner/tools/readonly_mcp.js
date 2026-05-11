import { createInterface } from "readline";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { resolveAllowedPath } from "./path_guard.js";
import {
  buildReadonlySearchArgs,
  createReadonlySearchCollector,
  normalizeReadonlyReadBytes,
  normalizeReadonlySearchMaxResults
} from "./readonly_args.js";
import {
  buildSensitiveReadonlySearchGlobs,
  shouldBlockSensitiveRepoPath
} from "./readonly_sensitive_paths.js";

const repoRoot = path.resolve(process.env.WORK_REPO_ROOT || "/work/repo");
const bundleRoot = path.resolve(process.env.WORK_BUNDLE_ROOT || "/work/bundle");
const outRoot = path.resolve(process.env.WORK_OUT_ROOT || "/work/out");
const searchRoots = [repoRoot, bundleRoot, outRoot];
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
    description: "Search text in the repo, bundle, or output files.",
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

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function repoRelativePathForTarget(target) {
  if (!isWithinRoot(repoRoot, target)) {
    return null;
  }
  return path.relative(repoRoot, target).replace(/\\/g, "/");
}

async function handleReadFile(args) {
  const target = await resolveAllowedPath(args.path, { baseRoot: repoRoot, roots: readRoots });
  const repoRelativePath = repoRelativePathForTarget(target);
  if (repoRelativePath && shouldBlockSensitiveRepoPath(repoRelativePath)) {
    throw new Error("Path not allowed in repo");
  }
  if (target.startsWith(outRoot)) {
    const isAllowedOutput =
      target.endsWith(".json") || target.endsWith(".txt");
    if (!isAllowedOutput) {
      throw new Error("Path not allowed in output dir");
    }
  }
  const maxBytes = normalizeReadonlyReadBytes(args.max_bytes);
  const handle = await fs.open(target, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return asText(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function runRipgrep(args) {
  const query = args.query;
  const maxResults = normalizeReadonlySearchMaxResults(args.max_results);
  const searchRoot = args.path
    ? await resolveAllowedPath(args.path, { baseRoot: repoRoot, roots: searchRoots })
    : repoRoot;
  const repoRelativeSearchRoot = repoRelativePathForTarget(searchRoot);
  if (
    repoRelativeSearchRoot &&
    repoRelativeSearchRoot.length > 0 &&
    shouldBlockSensitiveRepoPath(repoRelativeSearchRoot)
  ) {
    return asText("No matches");
  }
  const searchRootStat = await fs.stat(searchRoot).catch(() => null);
  const searchBasePath =
    searchRootStat?.isDirectory() === true ? searchRoot : path.dirname(searchRoot);

  const rgArgs = buildReadonlySearchArgs({
    query,
    glob: args.glob,
    searchRoot,
    maxResults,
    extraGlobs: repoRelativeSearchRoot !== null ? buildSensitiveReadonlySearchGlobs() : []
  });

  const proc = spawn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const collector = createReadonlySearchCollector({
    maxResults,
    includeMatch: ({ path: matchPath }) => {
      if (repoRelativeSearchRoot === null) {
        return true;
      }
      const absolutePath = path.isAbsolute(matchPath)
        ? path.resolve(matchPath)
        : path.resolve(searchBasePath, matchPath);
      const repoRelativePath = repoRelativePathForTarget(absolutePath);
      if (!repoRelativePath) {
        return true;
      }
      return !shouldBlockSensitiveRepoPath(repoRelativePath);
    }
  });
  let stderr = "";
  let stoppedEarly = false;

  proc.stdout.on("data", (d) => {
    if (collector.pushChunk(d) && !stoppedEarly) {
      stoppedEarly = true;
      proc.kill("SIGKILL");
    }
  });
  proc.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });

  const code = await new Promise((resolve) => proc.on("close", resolve));
  const stdout = collector.finish().trim();
  if (!stoppedEarly && code !== 0 && stdout.length === 0) {
    return asText(stderr.trim() || "No matches");
  }

  return asText(stdout);
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
