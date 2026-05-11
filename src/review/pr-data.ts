import type { Octokit } from "@octokit/rest";
import { ensureGitRepoCheckout } from "../providers/repoCheckout.js";
import {
  fetchGithubPullRequestDiffWithinLimit,
  listGithubPullRequestFiles
} from "../providers/github/adapter.js";
import { buildLocalDiffPatch as buildBoundedLocalDiffPatch } from "./localCompare.js";
import { renderPrMarkdown as renderBoundedPrMarkdown } from "./prMarkdown.js";

type InstallationOctokit = ReturnType<
  typeof import("../github/auth.js").getInstallationOctokit
>;

async function resolveOctokitInstallationToken(octokit: InstallationOctokit): Promise<string> {
  const auth = await (octokit as Octokit & { auth?: () => Promise<unknown> }).auth?.();
  const token = (auth as { token?: unknown } | undefined)?.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("GitHub installation token unavailable for diff fetch");
  }
  return token;
}

export async function ensureRepoCheckout(params: {
  installationToken: string;
  owner: string;
  repo: string;
  headSha: string;
  pullRequestNumber?: number | null;
}): Promise<string> {
  const { installationToken, owner, repo, headSha, pullRequestNumber } = params;
  return ensureGitRepoCheckout({
    owner,
    repo,
    headSha,
    token: installationToken,
    pullRequestNumber
  });
}

export async function fetchDiffPatch(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const token = await resolveOctokitInstallationToken(octokit);
  return fetchGithubPullRequestDiffWithinLimit({
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
    token
  });
}

export async function buildLocalDiffPatch(params: {
  repoPath: string;
  baseSha: string;
  headSha: string;
}): Promise<string> {
  return buildBoundedLocalDiffPatch(params);
}

export async function listChangedFiles(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  prNumber: number
) {
  return listGithubPullRequestFiles({
    octokit: octokit as unknown as Octokit,
    owner,
    repo,
    pullNumber: prNumber
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
  return renderBoundedPrMarkdown(params);
}
