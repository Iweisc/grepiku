import fs from "fs/promises";
import { spawn } from "node:child_process";
import path from "path";
import { execa } from "execa";
import { gitCheckoutSafetyEnv } from "../github/gitAuth.js";

const WORKSPACE_OUTPUT_LIMIT_ERROR_PREFIX =
  "repo command workspace output exceeded byte limit";
const STDERR_ERROR_CAP_BYTES = 4096;
const TRACKED_DIFF_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
const UNTRACKED_LIST_OUTPUT_LIMIT_BYTES = 5 * 1024 * 1024;

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizeWorkspaceLabel(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 72) || "workspace"
  );
}

function buildIsolatedRepoCloneArgs(sourceRepoPath: string, workspaceRepoPath: string): string[] {
  return [
    "clone",
    "--quiet",
    "--no-local",
    "--no-checkout",
    "--",
    sourceRepoPath,
    workspaceRepoPath
  ];
}

export function buildRepoCommandWorkspacePaths(params: {
  baseDir: string;
  label: string;
}): { root: string; repoPath: string; homeDir: string } {
  const root = path.resolve(params.baseDir, sanitizeWorkspaceLabel(params.label));
  return {
    root,
    repoPath: path.join(root, "repo"),
    homeDir: path.join(root, "home")
  };
}

function parseNullSeparatedList(value: string): string[] {
  return value
    .split("\0")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function workspaceOutputLimitError(maxBytes: number): Error {
  return new Error(`${WORKSPACE_OUTPUT_LIMIT_ERROR_PREFIX} (cap: ${maxBytes} bytes)`);
}

async function captureGitStdoutWithinLimit(params: {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBytes: number;
}): Promise<string> {
  const child = spawn("git", params.args, {
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
    throw workspaceOutputLimitError(params.maxBytes);
  }
  if (code !== 0) {
    throw new Error(stderr.trim() || `git exited with ${code ?? signal ?? "unknown"}`);
  }
  return Buffer.concat(stdoutChunks).toString("utf8");
}

export async function assertWorkspaceHasNoExternalSymlinks(root: string): Promise<void> {
  const resolvedRoot = await fs.realpath(root);

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) {
        continue;
      }

      const linkTarget = await fs.readlink(entryPath);
      const lexicalTarget = path.resolve(
        path.dirname(entryPath),
        path.isAbsolute(linkTarget) ? linkTarget : linkTarget
      );
      if (!isWithinRoot(resolvedRoot, lexicalTarget)) {
        throw new Error(
          `blocked: repo symlink ${path.relative(root, entryPath) || entry.name} resolves outside the isolated workspace`
        );
      }

      const realTarget = await fs.realpath(entryPath).catch((err: NodeJS.ErrnoException | Error) => {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          return null;
        }
        throw err;
      });
      if (realTarget && !isWithinRoot(resolvedRoot, realTarget)) {
        throw new Error(
          `blocked: repo symlink ${path.relative(root, entryPath) || entry.name} resolves outside the isolated workspace`
        );
      }
    }
  }

  await walk(root);
}

async function copyWorkspaceFile(params: {
  sourceRepoPath: string;
  workspaceRepoPath: string;
  relativePath: string;
}): Promise<void> {
  const sourcePath = path.resolve(params.sourceRepoPath, params.relativePath);
  const destinationPath = path.resolve(params.workspaceRepoPath, params.relativePath);
  if (
    !isWithinRoot(params.sourceRepoPath, sourcePath) ||
    !isWithinRoot(params.workspaceRepoPath, destinationPath)
  ) {
    throw new Error(`Workspace copy path escapes repo roots: ${params.relativePath}`);
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.cp(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    dereference: false,
    errorOnExist: false,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
}

async function applyTrackedChanges(params: {
  sourceRepoPath: string;
  workspaceRepoPath: string;
  maxDiffBytes?: number;
}): Promise<void> {
  const stdout = await captureGitStdoutWithinLimit({
    args: ["-C", params.sourceRepoPath, "diff", "--binary", "HEAD", "--"],
    env: gitCheckoutSafetyEnv(),
    maxBytes: params.maxDiffBytes ?? TRACKED_DIFF_OUTPUT_LIMIT_BYTES
  });
  if (!stdout.trim()) {
    return;
  }
  await execa("git", ["-C", params.workspaceRepoPath, "apply", "--whitespace=nowarn"], {
    env: gitCheckoutSafetyEnv(),
    input: stdout,
    stdout: "ignore",
    stderr: "pipe"
  });
}

async function copyUntrackedChanges(params: {
  sourceRepoPath: string;
  workspaceRepoPath: string;
  maxListBytes?: number;
}): Promise<void> {
  const stdout = await captureGitStdoutWithinLimit({
    args: ["-C", params.sourceRepoPath, "ls-files", "--others", "--exclude-standard", "-z"],
    env: gitCheckoutSafetyEnv(),
    maxBytes: params.maxListBytes ?? UNTRACKED_LIST_OUTPUT_LIMIT_BYTES
  });

  for (const relativePath of parseNullSeparatedList(stdout)) {
    await copyWorkspaceFile({
      sourceRepoPath: params.sourceRepoPath,
      workspaceRepoPath: params.workspaceRepoPath,
      relativePath
    });
  }
}

export async function createRepoCommandWorkspace(params: {
  sourceRepoPath: string;
  baseDir: string;
  label: string;
  trackedDiffMaxBytes?: number;
  untrackedListMaxBytes?: number;
}): Promise<{
  root: string;
  repoPath: string;
  homeDir: string;
  cleanup: () => Promise<void>;
}> {
  const paths = buildRepoCommandWorkspacePaths({
    baseDir: params.baseDir,
    label: params.label
  });

  await fs.mkdir(params.baseDir, { recursive: true });
  await fs.rm(paths.root, { recursive: true, force: true });
  await fs.mkdir(paths.root, { recursive: true });

  try {
    const { stdout: sourceHeadSha } = await execa(
      "git",
      ["-C", params.sourceRepoPath, "rev-parse", "HEAD"],
      { env: gitCheckoutSafetyEnv(), maxBuffer: 1024 * 1024 * 5 }
    );
    await execa("git", buildIsolatedRepoCloneArgs(params.sourceRepoPath, paths.repoPath), {
      env: gitCheckoutSafetyEnv(),
      maxBuffer: 1024 * 1024 * 50
    });
    await execa("git", ["-C", paths.repoPath, "checkout", "--quiet", "--detach", sourceHeadSha.trim()], {
      env: gitCheckoutSafetyEnv(),
      maxBuffer: 1024 * 1024 * 50
    });
    await applyTrackedChanges({
      sourceRepoPath: params.sourceRepoPath,
      workspaceRepoPath: paths.repoPath,
      maxDiffBytes: params.trackedDiffMaxBytes
    });
    await copyUntrackedChanges({
      sourceRepoPath: params.sourceRepoPath,
      workspaceRepoPath: paths.repoPath,
      maxListBytes: params.untrackedListMaxBytes
    });
    await assertWorkspaceHasNoExternalSymlinks(paths.repoPath);
  } catch (error) {
    await fs.rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    ...paths,
    cleanup: async () => {
      await fs.rm(paths.root, { recursive: true, force: true });
    }
  };
}
