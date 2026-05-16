import { createInterface } from "readline";
import fs from "fs/promises";

const tools = [
  {
    name: "retrieve_context",
    description: "Retrieve relevant files/symbols for this repo using PageIndex + graph.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "integer" }
      },
      required: ["query"]
    }
  }
];

const apiUrl = process.env.INTERNAL_API_URL || "http://web:3000/internal/retrieval";
const apiKey = process.env.INTERNAL_API_KEY || "";
const repoId = process.env.REVIEW_REPO_ID || "";
const contextPackPath = process.env.RETRIEVAL_CONTEXT_PACK_PATH || "";

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

async function callRetrieve(args) {
  if (contextPackPath) {
    return retrieveFromContextPack(args);
  }
  const body = {
    repoId: Number(repoId),
    query: args.query,
    topK: args.top_k
  };
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["x-internal-key"] = apiKey;
  }
  const res = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Retrieval API ${res.status}: ${text}`);
  }
  const data = await res.json();
  const lines = (data.results || [])
    .map((item) => {
      const label = item.kind === "symbol" ? `symbol:${item.symbol}` : `file:${item.path}`;
      return `${label} (score ${item.score.toFixed(3)})\n${item.text}`;
    })
    .join("\n\n");
  return asText(lines);
}

function queryTerms(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((term) => term.length >= 2)
    .slice(0, 24);
}

function scoreContextItem(item, terms) {
  const haystack = [
    item.path || "",
    item.symbol || "",
    item.kind || "",
    item.text || ""
  ]
    .join("\n")
    .toLowerCase();
  let score = Number(item.score || 0);
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

async function retrieveFromContextPack(args) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(contextPackPath, "utf8"));
  } catch {
    return asText("");
  }
  const terms = queryTerms(args.query);
  const topK = Math.max(1, Math.min(20, Number(args.top_k || 8)));
  const retrieved = Array.isArray(parsed?.retrieved) ? parsed.retrieved : [];
  const lines = retrieved
    .map((item) => ({
      item,
      score: scoreContextItem(item, terms)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ item, score }) => {
      const label = item.kind === "symbol" ? `symbol:${item.symbol || item.path || ""}` : `file:${item.path || ""}`;
      return `${label} (score ${score.toFixed(3)})\n${item.text || ""}`;
    })
    .join("\n\n");
  return asText(lines);
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
        serverInfo: { name: "grepiku-retrieval", version: "0.1.0" }
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
      if (name === "retrieve_context") {
        const result = await callRetrieve(args);
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
