import { spawn } from "node:child_process";
import { gitCheckoutSafetyEnv } from "../github/gitAuth.js";
import { normalizePath } from "./diff.js";

export type LocalChangedFile = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string | null;
};

type DiffTooLargeError = {
  status?: number;
  message?: string;
  response?: {
    data?: {
      message?: string;
      errors?: Array<{ field?: string; code?: string }>;
    };
  };
};

const OUTPUT_LIMIT_ERROR_PREFIX = "local compare output exceeded byte limit";
const STDERR_ERROR_CAP_BYTES = 4096;
const LOCAL_DIFF_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
const LOCAL_CHANGED_FILES_OUTPUT_LIMIT_BYTES = 5 * 1024 * 1024;

function outputLimitError(maxBytes: number): Error {
  return new Error(`${OUTPUT_LIMIT_ERROR_PREFIX} (cap: ${maxBytes} bytes)`);
}

function splitNullSeparatedFields(value: string): string[] {
  return value.split("\0").filter((item) => item.length > 0);
}

function parseNumStatHeader(value: string): {
  additions?: number;
  deletions?: number;
  path: string;
} | null {
  const firstTab = value.indexOf("\t");
  const secondTab = value.indexOf("\t", firstTab + 1);
  if (firstTab < 0 || secondTab < 0) {
    return null;
  }

  const additionsRaw = value.slice(0, firstTab);
  const deletionsRaw = value.slice(firstTab + 1, secondTab);
  const additions = additionsRaw === "-" ? undefined : Number(additionsRaw);
  const deletions = deletionsRaw === "-" ? undefined : Number(deletionsRaw);

  return {
    additions: Number.isFinite(additions) ? additions : undefined,
    deletions: Number.isFinite(deletions) ? deletions : undefined,
    path: normalizePath(value.slice(secondTab + 1))
  };
}

export function isCommandOutputTooLargeError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(OUTPUT_LIMIT_ERROR_PREFIX);
}

export function isDiffTooLargeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const data = err as DiffTooLargeError;
  if (data.status !== 406) return false;

  const message = data.message || data.response?.data?.message;
  if (typeof message === "string" && message.toLowerCase().includes("diff exceeded")) {
    return true;
  }

  const errors = data.response?.data?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((entry) => entry?.field === "diff" && entry?.code === "too_large");
}

export async function resolveDiffPatchAfterLocalCompareFailure(params: {
  fetchProviderDiff: () => Promise<string>;
  buildLocalDiff: () => Promise<string>;
}): Promise<string> {
  try {
    return await params.fetchProviderDiff();
  } catch (providerError) {
    if (isDiffTooLargeError(providerError)) {
      return "";
    }
    try {
      return await params.buildLocalDiff();
    } catch (localError) {
      if (isCommandOutputTooLargeError(localError)) {
        return "";
      }
      throw localError;
    }
  }
}

export async function captureCommandStdoutWithinLimit(params: {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBytes: number;
}): Promise<string> {
  const child = spawn(params.file, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }
  );
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  let exceededLimit = false;

  const stderrPromise = (async () => {
    for await (const chunk of child.stderr) {
      if (stderr.length >= STDERR_ERROR_CAP_BYTES) break;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      stderr += text.slice(0, Math.max(0, STDERR_ERROR_CAP_BYTES - stderr.length));
    }
  })();

  try {
    for await (const chunk of child.stdout) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stdoutBytes += buffer.length;
      if (stdoutBytes > params.maxBytes) {
        exceededLimit = true;
        child.kill("SIGKILL");
        break;
      }
      stdoutChunks.push(buffer);
    }
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  const { code, signal } = await closePromise;
  await stderrPromise;

  if (exceededLimit) {
    throw outputLimitError(params.maxBytes);
  }
  if (code !== 0) {
    throw new Error(stderr.trim() || `command exited with ${code ?? signal ?? "unknown"}`);
  }
  return Buffer.concat(stdoutChunks).toString("utf8");
}

export async function buildLocalDiffPatch(params: {
  repoPath: string;
  baseSha: string | null | undefined;
  headSha: string;
  maxBytes?: number;
}): Promise<string> {
  const { repoPath, baseSha, headSha } = params;
  if (!baseSha) return "";
  return captureCommandStdoutWithinLimit({
    file: "git",
    args: ["-C", repoPath, "diff", "--no-color", "--no-ext-diff", `${baseSha}...${headSha}`],
    env: gitCheckoutSafetyEnv(),
    maxBytes: params.maxBytes ?? LOCAL_DIFF_OUTPUT_LIMIT_BYTES
  });
}

export async function buildLocalChangedFiles(params: {
  repoPath: string;
  baseSha: string | null | undefined;
  headSha: string;
}): Promise<LocalChangedFile[]> {
  const { repoPath, baseSha, headSha } = params;
  if (!baseSha) return [];

  const [nameStatusOut, numStatOut] = await Promise.all([
    captureCommandStdoutWithinLimit({
      file: "git",
      args: ["-C", repoPath, "diff", "--no-ext-diff", "--name-status", "-z", `${baseSha}...${headSha}`],
      env: gitCheckoutSafetyEnv(),
      maxBytes: LOCAL_CHANGED_FILES_OUTPUT_LIMIT_BYTES
    }),
    captureCommandStdoutWithinLimit({
      file: "git",
      args: ["-C", repoPath, "diff", "--no-ext-diff", "--numstat", "-z", `${baseSha}...${headSha}`],
      env: gitCheckoutSafetyEnv(),
      maxBytes: LOCAL_CHANGED_FILES_OUTPUT_LIMIT_BYTES
    })
  ]);

  return mergeLocalChangedFiles(nameStatusOut, numStatOut);
}

export function mergeLocalChangedFiles(nameStatus: string, numStat: string): LocalChangedFile[] {
  if (nameStatus.includes("\0") || numStat.includes("\0")) {
    return mergeNullSeparatedLocalChangedFiles(nameStatus, numStat);
  }

  const byPath = new Map<string, LocalChangedFile>();

  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    const rawStatus = parts[0] || "";
    const path = normalizePath(parts[parts.length - 1] || "");
    if (!path) continue;
    byPath.set(path, {
      path,
      status: normalizeGitStatus(rawStatus),
      patch: null
    });
  }

  for (const line of numStat.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const additionsRaw = parts[0] || "";
    const deletionsRaw = parts[1] || "";

    const rawPath = parts[parts.length - 1] || "";
    const path = normalizePath(
      rawPath
        .replace(/^(.*)\{.* => (.*)\}(.*)$/, "$1$2$3")
        .replace(/^.* => /, "")
    );
    if (!path) continue;

    const additions = additionsRaw === "-" ? undefined : Number(additionsRaw);
    const deletions = deletionsRaw === "-" ? undefined : Number(deletionsRaw);
    const existing = byPath.get(path) || { path, patch: null };
    byPath.set(path, {
      ...existing,
      additions: Number.isFinite(additions) ? additions : undefined,
      deletions: Number.isFinite(deletions) ? deletions : undefined
    });
  }

  return Array.from(byPath.values());
}

function mergeNullSeparatedLocalChangedFiles(
  nameStatus: string,
  numStat: string
): LocalChangedFile[] {
  const byPath = new Map<string, LocalChangedFile>();

  const nameTokens = splitNullSeparatedFields(nameStatus);
  for (let index = 0; index < nameTokens.length; ) {
    const rawStatus = nameTokens[index++] || "";
    if (!rawStatus) continue;

    let path = normalizePath(nameTokens[index++] || "");
    if ((rawStatus.startsWith("R") || rawStatus.startsWith("C")) && index < nameTokens.length) {
      const renamedPath = normalizePath(nameTokens[index++] || "");
      if (renamedPath) {
        path = renamedPath;
      }
    }

    if (!path) continue;
    byPath.set(path, {
      path,
      status: normalizeGitStatus(rawStatus),
      patch: null
    });
  }

  const numTokens = splitNullSeparatedFields(numStat);
  for (let index = 0; index < numTokens.length; ) {
    const parsed = parseNumStatHeader(numTokens[index++] || "");
    if (!parsed) continue;

    let path = parsed.path;
    if (!path && index + 1 <= numTokens.length) {
      const _fromPath = normalizePath(numTokens[index++] || "");
      const toPath = normalizePath(numTokens[index++] || "");
      path = toPath || _fromPath;
    }

    if (!path) continue;
    const existing = byPath.get(path) || { path, patch: null };
    byPath.set(path, {
      ...existing,
      additions: parsed.additions,
      deletions: parsed.deletions
    });
  }

  return Array.from(byPath.values());
}

function normalizeGitStatus(value: string): string {
  const code = value.trim().toUpperCase();
  if (code.startsWith("A")) return "added";
  if (code.startsWith("M")) return "modified";
  if (code.startsWith("D")) return "removed";
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("C")) return "copied";
  if (code.startsWith("T")) return "changed";
  if (code.startsWith("U")) return "modified";
  return code || "modified";
}
