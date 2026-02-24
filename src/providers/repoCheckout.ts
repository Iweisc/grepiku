import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

function buildRemoteUrl(params: { owner: string; repo: string; token: string; baseUrl?: string }) {
  const base = params.baseUrl ? params.baseUrl.replace(/\/$/, "") : "https://github.com";
  const encodedToken = encodeURIComponent(params.token);
  if (base.includes("gitlab")) {
    const host = base.replace(/https?:\/\//, "");
    return `https://oauth2:${encodedToken}@${host}/${params.owner}/${params.repo}.git`;
  }
  if (base.includes("github") || base.includes("ghe")) {
    const host = base.replace(/https?:\/\//, "");
    return `https://x-access-token:${encodedToken}@${host}/${params.owner}/${params.repo}.git`;
  }
  return `${base.replace(/https?:\/\//, "https://")}/${params.owner}/${params.repo}.git`;
}

export async function ensureGitRepoCheckout(params: {
  owner: string;
  repo: string;
  headSha: string;
  token: string;
  baseUrl?: string;
}): Promise<string> {
  const { owner, repo, headSha, token, baseUrl } = params;
  const baseDir = path.join(env.projectRoot, "var", "repos", owner, repo);
  const worktreesDir = path.join(env.projectRoot, "var", "repos", owner, `${repo}-worktrees`);
  const worktreePath = path.join(worktreesDir, headSha);

  await fs.mkdir(path.dirname(baseDir), { recursive: true });
  await fs.mkdir(worktreesDir, { recursive: true });

  const repoExists = await fs
    .stat(path.join(baseDir, ".git"))
    .then(() => true)
    .catch(() => false);

  const remoteUrl = buildRemoteUrl({ owner, repo, token, baseUrl });

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
