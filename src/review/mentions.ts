import fs from "fs/promises";
import path from "path";
import { prisma } from "../db/client.js";
import { getInstallationOctokit, getInstallationToken } from "../github/auth.js";
import { loadEnv } from "../config/env.js";
import { loadRepoConfig } from "./config.js";
import { writeBundleFiles } from "./bundle.js";
import { buildMentionPrompt } from "./prompts.js";
import { runCodexStage } from "../runner/codexRunner.js";
import { readAndValidateJson } from "./json.js";
import { ReplySchema } from "./schemas.js";
import {
  ensureRepoCheckout,
  fetchDiffPatch,
  listChangedFiles,
  renderPrMarkdown
} from "./pr-data.js";

const env = loadEnv();

export type CommentReplyJobData = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  commentBody: string;
  commentAuthor: string;
  commentUrl?: string;
};

async function createReplyDirs(root: string, commentId: number) {
  const runDir = path.join(root, "var", "replies", String(commentId));
  const bundleDir = path.join(runDir, "bundle");
  const outDir = path.join(runDir, "out");
  const codexHomeDir = path.join(runDir, "codex-home");
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(codexHomeDir, { recursive: true });
  await fs.mkdir(path.join(bundleDir, "repo_hints"), { recursive: true });
  return { runDir, bundleDir, outDir, codexHomeDir };
}

export async function processCommentReplyJob(data: CommentReplyJobData) {
  const { installationId, owner, repo, prNumber, commentId, commentBody, commentAuthor, commentUrl } =
    data;
  const octokit = getInstallationOctokit(installationId);
  const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const head = pr.data.head.sha;

  const repoInstallation = await prisma.repoInstallation.upsert({
    where: { installationId },
    update: { owner, repo },
    create: { installationId, owner, repo }
  });

  const installationToken = await getInstallationToken(installationId);
  const repoPath = await ensureRepoCheckout({
    installationToken,
    owner,
    repo,
    headSha: head
  });

  const repoConfig = await loadRepoConfig(repoPath);
  const diffPatch = await fetchDiffPatch(octokit, owner, repo, prNumber);
  const changedFiles = await listChangedFiles(octokit, owner, repo, prNumber);

  const prMarkdown = renderPrMarkdown({
    title: pr.data.title,
    number: prNumber,
    author: pr.data.user?.login || "unknown",
    body: pr.data.body,
    baseRef: pr.data.base.ref,
    headRef: pr.data.head.ref,
    headSha: head,
    url: pr.data.html_url
  });

  const { bundleDir, outDir, codexHomeDir } = await createReplyDirs(
    env.projectRoot,
    commentId
  );
  await writeBundleFiles({
    bundleDir,
    prMarkdown,
    diffPatch,
    changedFiles,
    repoConfig
  });

  const prompt = buildMentionPrompt({
    commentBody,
    commentAuthor,
    commentUrl
  });

  await runCodexStage({
    stage: "reviewer",
    repoPath,
    bundleDir,
    outDir,
    codexHomeDir,
    prompt,
    headSha: head,
    repoInstallationId: repoInstallation.id,
    prNumber
  });

  const reply = await readAndValidateJson(path.join(outDir, "reply.json"), ReplySchema);

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: reply.body
  });
}
