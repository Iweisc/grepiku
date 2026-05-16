import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { loadEnv } from "../config/env.js";
import {
  execaAuthenticatedGit,
  gitCheckoutSafetyEnv,
  githubRemoteUrl
} from "../github/gitAuth.js";

const SAME_SHA_WORKTREE_TTL_MS = 6 * 60 * 60 * 1000;
const SAME_SHA_WORKTREE_KEEP_RECENT = 2;
const repoCheckoutChains = new Map<string, Promise<void>>();

async function withRepoCheckoutLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoCheckoutChains.get(repoKey) || Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduled = previous.catch(() => undefined).then(() => gate);
  repoCheckoutChains.set(repoKey, scheduled);
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (repoCheckoutChains.get(repoKey) === scheduled) {
      repoCheckoutChains.delete(repoKey);
    }
  }
}

function toWorktreeKey(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) return "HEAD";
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) return trimmed.toLowerCase();
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "HEAD";
}

function normalizePullRequestNumber(value: number | null | undefined): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function pullRequestHeadRef(prNumber: number | null | undefined): string | null {
  const normalized = normalizePullRequestNumber(prNumber);
  if (!normalized) return null;
  return `refs/remotes/origin/pull/${normalized}/head`;
}

function pullRequestHeadRefspec(prNumber: number | null | undefined): string | null {
  const normalized = normalizePullRequestNumber(prNumber);
  if (!normalized) return null;
  return `+refs/pull/${normalized}/head:${pullRequestHeadRef(normalized)}`;
}

async function resolveCheckoutRef(
  baseDir: string,
  requestedRef: string,
  pullRequestNumber?: number | null
): Promise<string> {
  const candidates =
    requestedRef === "HEAD"
      ? ["origin/HEAD", "HEAD"]
      : [requestedRef, pullRequestHeadRef(pullRequestNumber)].filter(
          (value): value is string => Boolean(value)
        );
  for (const candidate of candidates) {
    try {
      const { stdout } = await execa("git", ["-C", baseDir, "rev-parse", "--verify", candidate], {
        stdio: ["ignore", "pipe", "ignore"],
        env: gitCheckoutSafetyEnv()
      });
      const resolved = stdout.trim();
      if (resolved) return resolved;
    } catch {
      // keep trying candidates
    }
  }
  return requestedRef;
}

type SameShaWorktreeCandidate = {
  path: string;
  mtimeMs: number;
  registered: boolean;
};

export function selectSameShaWorktreesForCleanup(params: {
  candidates: SameShaWorktreeCandidate[];
  nowMs: number;
  ttlMs?: number;
  keepRecent?: number;
}): SameShaWorktreeCandidate[] {
  const ttlMs = params.ttlMs ?? SAME_SHA_WORKTREE_TTL_MS;
  const keepRecent = params.keepRecent ?? SAME_SHA_WORKTREE_KEEP_RECENT;
  const sorted = [...params.candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const protectedPaths = new Set(sorted.slice(0, keepRecent).map((item) => item.path));
  const stale = sorted.filter((item) => {
    if (protectedPaths.has(item.path)) return false;
    return params.nowMs - item.mtimeMs >= ttlMs;
  });
  return stale.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

async function listRegisteredWorktrees(baseDir: string): Promise<Set<string>> {
  const { stdout } = await execa("git", ["-C", baseDir, "worktree", "list", "--porcelain"], {
    stdio: ["ignore", "pipe", "ignore"],
    env: gitCheckoutSafetyEnv()
  });
  const registered = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktreePath = line.slice("worktree ".length).trim();
    if (!worktreePath) continue;
    registered.add(path.resolve(worktreePath));
  }
  return registered;
}

async function pruneSameShaWorktrees(params: {
  baseDir: string;
  worktreesDir: string;
  headSha: string;
}): Promise<void> {
  const { baseDir, worktreesDir, headSha } = params;
  await execa("git", ["-C", baseDir, "worktree", "prune", "--expire=now"], {
    stdio: ["ignore", "ignore", "ignore"],
    env: gitCheckoutSafetyEnv()
  }).catch(() => undefined);

  const registered = await listRegisteredWorktrees(baseDir).catch(() => new Set<string>());
  const entries = await fs.readdir(worktreesDir, { withFileTypes: true }).catch(() => []);
  const candidates: SameShaWorktreeCandidate[] = [];
  const prefix = `${headSha}-`;
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidatePath = path.resolve(worktreesDir, entry.name);
    const stat = await fs.stat(candidatePath).catch(() => null);
    if (!stat) continue;
    candidates.push({
      path: candidatePath,
      mtimeMs: stat.mtimeMs,
      registered: registered.has(candidatePath)
    });
  }

  if (candidates.length === 0) return;
  const stale = selectSameShaWorktreesForCleanup({
    candidates,
    nowMs: Date.now()
  });

  for (const candidate of stale) {
    if (candidate.registered) {
      await execa("git", ["-C", baseDir, "worktree", "remove", "--force", candidate.path], {
        stdio: ["ignore", "ignore", "ignore"],
        env: gitCheckoutSafetyEnv()
      }).catch(() => undefined);
    }
    await fs.rm(candidate.path, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function ensureGitRepoCheckout(params: {
  owner: string;
  repo: string;
  headSha: string;
  token: string;
  pullRequestNumber?: number | null;
}): Promise<string> {
  const { owner, repo, headSha, token, pullRequestNumber } = params;
  return withRepoCheckoutLock(`${owner}/${repo}`, async () => {
    const env = loadEnv();
    const baseDir = path.join(env.projectRoot, "var", "repos", owner, repo);
    const worktreesDir = path.join(env.projectRoot, "var", "repos", owner, `${repo}-worktrees`);

    await fs.mkdir(path.dirname(baseDir), { recursive: true });
    await fs.mkdir(worktreesDir, { recursive: true });

    const repoExists = await fs
      .stat(path.join(baseDir, ".git"))
      .then(() => true)
      .catch(() => false);

    const remoteUrl = githubRemoteUrl({ owner, repo });

    if (!repoExists) {
      await execaAuthenticatedGit(token, ["clone", remoteUrl, baseDir], {
        stdio: "inherit",
        env: gitCheckoutSafetyEnv()
      });
    } else {
      await execa("git", ["-C", baseDir, "remote", "set-url", "origin", remoteUrl], {
        stdio: "inherit",
        env: gitCheckoutSafetyEnv()
      });
      await execaAuthenticatedGit(token, ["-C", baseDir, "fetch", "--all", "--prune"], {
        stdio: "inherit",
        env: gitCheckoutSafetyEnv()
      });
    }

    const prHeadRefspec = pullRequestHeadRefspec(pullRequestNumber);
    if (prHeadRefspec) {
      await execaAuthenticatedGit(token, ["-C", baseDir, "fetch", "--prune", "origin", prHeadRefspec], {
        stdio: "inherit",
        env: gitCheckoutSafetyEnv()
      });
    }

    await execa("git", ["-C", baseDir, "remote", "set-head", "origin", "-a"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: gitCheckoutSafetyEnv()
    }).catch(() => undefined);

    const checkoutRef = await resolveCheckoutRef(baseDir, headSha, pullRequestNumber);
    const worktreeKey = toWorktreeKey(checkoutRef);

    await pruneSameShaWorktrees({ baseDir, worktreesDir, headSha: worktreeKey });

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const suffix = `${Date.now()}-${process.pid}-${attempt}`;
      const worktreePath = path.join(worktreesDir, `${worktreeKey}-${suffix}`);
      try {
        await execa("git", ["-C", baseDir, "worktree", "add", "--detach", worktreePath, checkoutRef], {
          stdio: "inherit",
          env: gitCheckoutSafetyEnv()
        });
        return worktreePath;
      } catch (err: any) {
        lastError = err;
        const stderr = String(err?.stderr || err?.shortMessage || err?.message || "");
        if (!stderr.includes("already exists")) {
          throw err;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to create git worktree");
  });
}
