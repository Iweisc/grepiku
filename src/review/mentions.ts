import fs from "fs/promises";
import path from "path";
import { prisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { loadRepoConfig, saveRepoConfig } from "./config.js";
import { writeBundleFiles } from "./bundle.js";
import { buildMentionPrompt } from "./prompts.js";
import { runCodexStage } from "../runner/codexRunner.js";
import { readAndValidateJson } from "./json.js";
import { ReplySchema } from "./schemas.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderPullRequest, ProviderRepo } from "../providers/types.js";
import { buildContextPack } from "./context.js";
import { execa } from "execa";

const env = loadEnv();

export type CommentReplyJobData = {
  provider: "github";
  installationId?: string | null;
  repoId: number;
  pullRequestId: number;
  prNumber: number;
  commentId: string;
  commentBody: string;
  commentAuthor: string;
  commentUrl?: string;
};

async function createReplyDirs(root: string, commentId: string) {
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

async function buildLocalDiffPatch(params: {
  repoPath: string;
  baseSha: string | null | undefined;
  headSha: string;
}): Promise<string> {
  const { repoPath, baseSha, headSha } = params;
  if (!baseSha) return "";
  const { stdout } = await execa(
    "git",
    ["-C", repoPath, "diff", "--no-color", "--no-ext-diff", `${baseSha}...${headSha}`],
    { maxBuffer: 1024 * 1024 * 200 }
  );
  return stdout;
}

export async function processCommentReplyJob(data: CommentReplyJobData) {
  const { provider, installationId, repoId, pullRequestId, prNumber, commentId, commentBody, commentAuthor, commentUrl } =
    data;
  const repo = await prisma.repo.findFirst({ where: { id: repoId } });
  const pullRequest = await prisma.pullRequest.findFirst({ where: { id: pullRequestId } });
  if (!repo || !pullRequest) return;

  const adapter = getProviderAdapter(provider);
  const providerRepo: ProviderRepo = {
    externalId: repo.externalId,
    owner: repo.owner,
    name: repo.name,
    fullName: repo.fullName
  };
  const providerPull: ProviderPullRequest = {
    externalId: pullRequest.externalId,
    number: prNumber,
    title: pullRequest.title || null,
    body: pullRequest.body || null,
    url: pullRequest.url || null,
    state: pullRequest.state,
    headSha: pullRequest.headSha || ""
  };
  const client = await adapter.createClient({
    installationId: installationId || null,
    repo: providerRepo,
    pullRequest: providerPull
  });
  const refreshed = await client.fetchPullRequest();

  const repoPath = await client.ensureRepoCheckout({ headSha: refreshed.headSha });
  const { config: repoConfig, warnings } = await loadRepoConfig(repoPath);
  await saveRepoConfig(repo.id, repoConfig, warnings);
  let diffPatch = "";
  try {
    diffPatch = await client.fetchDiffPatch();
  } catch {
    diffPatch = await buildLocalDiffPatch({
      repoPath,
      baseSha: refreshed.baseSha,
      headSha: refreshed.headSha
    });
  }
  const changedFiles = await client.listChangedFiles();
  const contextPack = await buildContextPack({
    repoId: repo.id,
    diffPatch,
    changedFiles: changedFiles as Array<{ filename?: string; path?: string }>
  });

  const prMarkdown = `# PR #${prNumber}: ${refreshed.title || pullRequest.title || "Untitled"}

Author: ${refreshed.author?.login || "unknown"}
Base: ${refreshed.baseRef || ""}
Head: ${refreshed.headRef || ""}
Head SHA: ${refreshed.headSha}
URL: ${refreshed.url || ""}

## Description
${refreshed.body || pullRequest.body || "(no description)"}
`;

  const { bundleDir, outDir, codexHomeDir } = await createReplyDirs(env.projectRoot, commentId);
  await writeBundleFiles({
    bundleDir,
    prMarkdown,
    diffPatch,
    changedFiles,
    repoConfig,
    resolvedConfig: repoConfig,
    contextPack,
    warnings
  });

  const prompt = buildMentionPrompt({
    commentBody,
    commentAuthor,
    commentUrl,
    repoPath,
    bundleDir,
    outDir
  });

  await runCodexStage({
    stage: "reviewer",
    repoPath,
    bundleDir,
    outDir,
    codexHomeDir,
    prompt,
    headSha: refreshed.headSha,
    repoId: repo.id,
    reviewRunId: 0,
    prNumber,
    captureLastMessage: false
  });

  const reply = await readAndValidateJson(path.join(outDir, "reply.json"), ReplySchema);

  await client.createSummaryComment(reply.body);
}
