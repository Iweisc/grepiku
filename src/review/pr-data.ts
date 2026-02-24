import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { loadEnv } from "../config/env.js";
import { getInstallationOctokit } from "../github/auth.js";

const env = loadEnv();

export async function ensureRepoCheckout(params: {
  installationToken: string;
  owner: string;
  repo: string;
  headSha: string;
}): Promise<string> {
  const { installationToken, owner, repo, headSha } = params;
  const baseDir = path.join(env.projectRoot, "var", "repos", owner, repo);
  const worktreesDir = path.join(env.projectRoot, "var", "repos", owner, `${repo}-worktrees`);
  const worktreePath = path.join(worktreesDir, headSha);

  await fs.mkdir(path.dirname(baseDir), { recursive: true });
  await fs.mkdir(worktreesDir, { recursive: true });

  const repoExists = await fs
    .stat(path.join(baseDir, ".git"))
    .then(() => true)
    .catch(() => false);

  const remoteUrl = `https://x-access-token:${installationToken}@github.com/${owner}/${repo}.git`;

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

export async function fetchDiffPatch(
  octokit: ReturnType<typeof getInstallationOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner,
      repo,
      pull_number: prNumber,
      headers: {
        accept: "application/vnd.github.v3.diff"
      }
    }
  );

  return response.data as unknown as string;
}

export async function listChangedFiles(
  octokit: ReturnType<typeof getInstallationOctokit>,
  owner: string,
  repo: string,
  prNumber: number
) {
  return octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100
  });
}

export function renderPrMarkdown(params: {
  title: string;
  number: number;
  author: string;
  body?: string | null;
  baseRef: string;
  headRef: string;
  headSha: string;
  url: string;
}): string {
  const { title, number, author, body, baseRef, headRef, headSha, url } = params;
  return `# PR #${number}: ${title}

Author: ${author}
Base: ${baseRef}
Head: ${headRef}
Head SHA: ${headSha}
URL: ${url}

## Description
${body || "(no description)"}
`;
}
