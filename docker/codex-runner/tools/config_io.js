import fs from "fs/promises";
import path from "path";

const TOOL_NAMES = ["lint", "build", "test"];

function normalizeToolEntry(value) {
  if (!value || typeof value !== "object") return null;
  const cmd = typeof value.cmd === "string" ? value.cmd.trim() : "";
  if (!cmd) return null;
  const timeoutRaw = Number(value.timeout_sec);
  const timeout_sec =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 600;
  return { cmd, timeout_sec };
}

export async function loadTrustedVerifierTools(params) {
  const bundleRoot = path.resolve(params.bundleRoot || "/work/bundle");
  const configPath = path.join(bundleRoot, "bot_config.json");

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return {};
  }

  const source = parsed?.tools;
  if (!source || typeof source !== "object") {
    return {};
  }

  const tools = {};
  for (const name of TOOL_NAMES) {
    const normalized = normalizeToolEntry(source[name]);
    if (normalized) {
      tools[name] = normalized;
    }
  }
  return tools;
}
