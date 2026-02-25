import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

function buildRemoteUrl(params: { owner: string; repo: string; token: string }) {
  const encodedToken = encodeURIComponent(params.token);
  return `https://x-access-token:${encodedToken}@github.com/${params.owner}/${params.repo}.git`;
}

export async function ensureGitRepoCheckout(params: {
  owner: string;
  repo: string;
  headSha: string;
  token: string;
}): Promise<string> {
  const { owner, repo, headSha, token } = params;
  const baseDir = path.join(env.projectRoot, "var", "repos", owner, repo);
  const worktreesDir = path.join(env.projectRoot, "var", "repos", owner, `${repo}-worktrees`);

  await fs.mkdir(path.dirname(baseDir), { recursive: true });
  await fs.mkdir(worktreesDir, { recursive: true });

  const repoExists = await fs
    .stat(path.join(baseDir, ".git"))
    .then(() => true)
    .catch(() => false);

  const remoteUrl = buildRemoteUrl({ owner, repo, token });

  if (!repoExists) {
    await execa("git", ["clone", remoteUrl, baseDir], { stdio: "inherit" });
  } else {
    await execa("git", ["-C", baseDir, "remote", "set-url", "origin", remoteUrl], {
      stdio: "inherit"
    });
    await execa("git", ["-C", baseDir, "fetch", "--all", "--prune"], { stdio: "inherit" });
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const suffix = `${Date.now()}-${process.pid}-${attempt}`;
    const worktreePath = path.join(worktreesDir, `${headSha}-${suffix}`);
    try {
      await execa("git", ["-C", baseDir, "worktree", "add", "--detach", worktreePath, headSha], {
        stdio: "inherit"
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
}
