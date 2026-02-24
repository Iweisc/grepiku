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
  const worktreePath = path.join(worktreesDir, headSha);

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

  const worktreeExists = await fs
    .stat(worktreePath)
    .then(() => true)
    .catch(() => false);

  if (worktreeExists) {
    await execa("git", ["-C", baseDir, "worktree", "remove", "--force", worktreePath], {
      stdio: "inherit"
    });
  }

  await execa("git", ["-C", baseDir, "worktree", "add", "--detach", worktreePath, headSha], {
    stdio: "inherit"
  });

  return worktreePath;
}
