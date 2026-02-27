import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { prisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { loadRepoConfig, saveRepoConfig, type RepoConfig, type ToolConfig } from "./config.js";
import { writeBundleFiles } from "./bundle.js";
import { buildMentionImplementPrompt, buildMentionPrompt } from "./prompts.js";
import { runCodexStage } from "../runner/codexRunner.js";
import { readAndValidateJson } from "./json.js";
import { MentionActionSchema, MentionChecksOutput, ReplySchema } from "./schemas.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderPullRequest, ProviderRepo } from "../providers/types.js";
import { buildContextPack } from "./context.js";
import { extractMentionDoTask } from "./triggers.js";
import { loadAcceptedRepoMemoryRules, mergeRulesWithRepoMemory } from "../services/repoMemory.js";
import {
  changedPaths,
  commitWorkingTree,
  hasWorkingTreeChanges,
  mentionBranchName,
  prepareMentionBranch,
  pushBranch,
  resolveFollowUpPrBaseBranch
} from "./mentionGit.js";
import { resolveGithubBotLogin } from "../providers/github/adapter.js";

const env = loadEnv();

type MentionToolResult = MentionChecksOutput["checks"]["lint"];

function topErrorsFromStderr(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 10);
}

async function runMentionTool(params: {
  repoPath: string;
  toolName: "lint" | "build" | "test";
  toolConfig?: ToolConfig;
}): Promise<MentionToolResult> {
  const { repoPath, toolConfig } = params;
  if (!toolConfig?.cmd) {
    return { status: "skipped", summary: "not configured", top_errors: [] };
  }

  const timeoutSec = Math.max(1, Math.floor(toolConfig.timeout_sec || 600));
  try {
    const result = await execa(toolConfig.cmd, {
      shell: true,
      cwd: repoPath,
      timeout: timeoutSec * 1000,
      reject: false
    });
    const topErrors = topErrorsFromStderr(result.stderr || "");
    if (result.exitCode === 0) {
      return { status: "pass", summary: "success", top_errors: topErrors };
    }
    return {
      status: "fail",
      summary: `exited with ${result.exitCode ?? "unknown"}`,
      top_errors: topErrors
    };
  } catch (err: any) {
    if (err?.timedOut) {
      return {
        status: "timeout",
        summary: `timed out after ${timeoutSec}s`,
        top_errors: topErrorsFromStderr(String(err?.stderr || ""))
      };
    }
    const message = err instanceof Error ? err.message : "tool execution error";
    return { status: "error", summary: message, top_errors: [] };
  }
}

async function runMentionChecks(params: {
  repoPath: string;
  tools: RepoConfig["tools"];
}): Promise<MentionChecksOutput> {
  const lint = await runMentionTool({
    repoPath: params.repoPath,
    toolName: "lint",
    toolConfig: params.tools.lint
  });
  const build = await runMentionTool({
    repoPath: params.repoPath,
    toolName: "build",
    toolConfig: params.tools.build
  });
  const test = await runMentionTool({
    repoPath: params.repoPath,
    toolName: "test",
    toolConfig: params.tools.test
  });
  return { checks: { lint, build, test } };
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

async function buildLocalChangedFiles(params: {
  repoPath: string;
  baseSha: string | null | undefined;
  headSha: string;
}): Promise<Array<{ path: string; status?: string }>> {
  const { repoPath, baseSha, headSha } = params;
  if (!baseSha) return [];
  const { stdout } = await execa(
    "git",
    ["-C", repoPath, "diff", "--name-status", `${baseSha}...${headSha}`],
    { maxBuffer: 1024 * 1024 * 20 }
  );
  const items = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line): { path: string; status?: string } | null => {
      const parts = line.split(/\t+/).filter(Boolean);
      if (parts.length < 2) return null;
      const status = parts[0];
      const filePath = parts[parts.length - 1];
      if (!filePath) return null;
      return {
        path: filePath,
        status
      };
    });
  return items.filter((value): value is { path: string; status?: string } => value !== null);
}

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
  replyInThread?: boolean;
};

async function postMentionReply(params: {
  client: {
    createSummaryComment: (body: string) => Promise<unknown>;
    replyToComment?: (params: { commentId: string; body: string }) => Promise<unknown>;
  };
  commentId: string;
  body: string;
  replyInThread?: boolean;
}) {
  const normalizedBody = normalizeReplyBody(params.body);
  if (params.client.replyToComment) {
    try {
      await params.client.replyToComment({
        commentId: params.commentId,
        body: normalizedBody
      });
      return;
    } catch (err) {
      if (params.replyInThread) {
        console.warn(`[mention ${params.commentId}] failed to post thread reply`, {
          error: err instanceof Error ? err.message : String(err)
        });
        return;
      }
    }
  }

  if (params.replyInThread) {
    console.warn(
      `[mention ${params.commentId}] thread reply requested but provider does not support replyToComment; skipping fallback summary comment`
    );
    return;
  }

  await params.client.createSummaryComment(normalizedBody);
}

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

function normalizeReplyBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\+n/g, "\n")
    .replace(/(^|[\s:;,.!?])\/n(?=\s*(?:\d+\.|[-*]|$))/gm, "$1\n")
    .trim();
}

function ensureMentionPrefix(body: string, author: string): string {
  const trimmed = body.trim();
  const prefix = `@${author}`;
  if (!trimmed) return `${prefix} I couldn't produce a response.`;
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return trimmed;
  return `${prefix} ${trimmed}`;
}

function withMentionMarker(body: string, commentId: string): string {
  return `<!-- grepiku-mention:${commentId} -->\n${body}`;
}

function defaultCommitMessage(task: string): string {
  const firstLine = task
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 52);
  if (!firstLine) return "chore: apply grepiku mention task";
  return `chore: ${firstLine}`;
}

function sanitizeCommitMessage(value: string | undefined, task: string): string {
  const fallback = defaultCommitMessage(task);
  if (!value) return fallback;
  const normalized = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 6)
    .join("\n")
    .trim();
  return normalized || fallback;
}

function defaultPrTitle(task: string): string {
  const summary = task
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 62);
  if (!summary) return "Grepiku follow-up changes";
  return `Grepiku: ${summary}`;
}

function formatCheckLine(result: { status: string; summary: string }): string {
  return `${result.status} - ${result.summary}`;
}

function checksMarkdown(checks: MentionChecksOutput): string {
  return [
    "## Validation",
    `- lint: ${formatCheckLine(checks.checks.lint)}`,
    `- build: ${formatCheckLine(checks.checks.build)}`,
    `- test: ${formatCheckLine(checks.checks.test)}`
  ].join("\n");
}

function formatChecksForComment(checks: MentionChecksOutput): string {
  return [
    "Checks:",
    `- lint: ${formatCheckLine(checks.checks.lint)}`,
    `- build: ${formatCheckLine(checks.checks.build)}`,
    `- test: ${formatCheckLine(checks.checks.test)}`
  ].join("\n");
}

function verificationFailedChecks(checks: MentionChecksOutput): boolean {
  const states = [checks.checks.lint.status, checks.checks.build.status, checks.checks.test.status];
  return states.some((state) => state === "fail" || state === "timeout" || state === "error");
}

function renderPrBody(params: {
  summary: string;
  prBodyHint?: string;
  task: string;
  commentUrl?: string;
  changedFiles: string[];
  checks: MentionChecksOutput;
}): string {
  const changedSection =
    params.changedFiles.length > 0
      ? params.changedFiles.map((item) => `- ${item}`).join("\n")
      : "- (no tracked file paths)";
  const bodyHint = params.prBodyHint?.trim();
  return [
    bodyHint || "",
    "## Request",
    params.task,
    "",
    "## Grepiku Summary",
    params.summary,
    "",
    "## Changed Files",
    changedSection,
    "",
    checksMarkdown(params.checks),
    "",
    params.commentUrl ? `Requested from: ${params.commentUrl}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function isCompleted(runDir: string): Promise<boolean> {
  const donePath = path.join(runDir, "completed.json");
  try {
    await fs.stat(donePath);
    return true;
  } catch {
    return false;
  }
}

async function markCompleted(runDir: string, payload: Record<string, unknown>): Promise<void> {
  const donePath = path.join(runDir, "completed.json");
  await fs.writeFile(donePath, JSON.stringify(payload, null, 2), "utf8");
}

async function runAnswerOnlyPath(params: {
  repoPath: string;
  bundleDir: string;
  outDir: string;
  codexHomeDir: string;
  commentBody: string;
  commentAuthor: string;
  commentUrl?: string;
  commentId: string;
  client: {
    createSummaryComment: (body: string) => Promise<unknown>;
    replyToComment?: (params: { commentId: string; body: string }) => Promise<unknown>;
  };
  replyInThread?: boolean;
  refreshedHeadSha: string;
  repoId: number;
  prNumber: number;
}): Promise<void> {
  const prompt = buildMentionPrompt({
    commentBody: params.commentBody,
    commentAuthor: params.commentAuthor,
    commentUrl: params.commentUrl,
    repoPath: params.repoPath,
    bundleDir: params.bundleDir,
    outDir: params.outDir
  });

  await runCodexStage({
    stage: "reviewer",
    repoPath: params.repoPath,
    bundleDir: params.bundleDir,
    outDir: params.outDir,
    codexHomeDir: params.codexHomeDir,
    prompt,
    headSha: params.refreshedHeadSha,
    repoId: params.repoId,
    reviewRunId: 0,
    prNumber: params.prNumber,
    captureLastMessage: false
  });

  const reply = await readAndValidateJson(path.join(params.outDir, "reply.json"), ReplySchema);
  const body = withMentionMarker(
    ensureMentionPrefix(reply.body, params.commentAuthor),
    params.commentId
  );
  await postMentionReply({
    client: params.client,
    commentId: params.commentId,
    body,
    replyInThread: params.replyInThread
  });
}

async function runImplementPath(params: {
  repoPath: string;
  bundleDir: string;
  outDir: string;
  codexHomeDir: string;
  commentBody: string;
  commentAuthor: string;
  commentUrl?: string;
  commentId: string;
  mentionTask: string;
  client: {
    createSummaryComment: (body: string) => Promise<unknown>;
    replyToComment?: (params: { commentId: string; body: string }) => Promise<unknown>;
    createPullRequest?: (params: {
      title: string;
      body: string;
      head: string;
      base: string;
      draft?: boolean;
    }) => Promise<ProviderPullRequest>;
    findOpenPullRequestByHead?: (params: { head: string; base?: string }) => Promise<ProviderPullRequest | null>;
  };
  refreshed: ProviderPullRequest;
  pullRequestBaseRef: string | null;
  pullRequestHeadRef: string | null;
  repoDefaultBranch: string | null;
  repoTools: RepoConfig["tools"];
  replyInThread?: boolean;
  repoId: number;
  prNumber: number;
}): Promise<{ mode: string; prUrl?: string | null; prNumber?: number }> {
  if (!params.client.createPullRequest) {
    const replyBody = withMentionMarker(
      ensureMentionPrefix("I cannot open pull requests with the current provider client.", params.commentAuthor),
      params.commentId
    );
    await postMentionReply({
      client: params.client,
      commentId: params.commentId,
      body: replyBody,
      replyInThread: params.replyInThread
    });
    return { mode: "answer" };
  }

  const appSlug = await resolveGithubBotLogin().catch(() => "grepiku");
  const botSlug = appSlug.replace(/\[bot\]$/i, "") || "grepiku";
  const branchName = mentionBranchName(params.commentId);
  await prepareMentionBranch({
    repoPath: params.repoPath,
    branchName,
    gitUserName: `${botSlug}[bot]`,
    gitUserEmail: `${botSlug}@users.noreply.github.com`
  });

  const implementPrompt = buildMentionImplementPrompt({
    commentBody: params.commentBody,
    commentAuthor: params.commentAuthor,
    commentUrl: params.commentUrl,
    task: params.mentionTask,
    repoPath: params.repoPath,
    bundleDir: params.bundleDir,
    outDir: params.outDir
  });

  await runCodexStage({
    stage: "mention",
    repoPath: params.repoPath,
    bundleDir: params.bundleDir,
    outDir: params.outDir,
    codexHomeDir: params.codexHomeDir,
    prompt: implementPrompt,
    headSha: params.refreshed.headSha,
    repoId: params.repoId,
    reviewRunId: 0,
    prNumber: params.prNumber,
    captureLastMessage: false
  });

  const action = await readAndValidateJson(
    path.join(params.outDir, "mention_action.json"),
    MentionActionSchema
  );

  const hasChanges = await hasWorkingTreeChanges(params.repoPath);
  if (!hasChanges || action.action !== "changed") {
    const fallback = action.action === "cannot_complete" ? action.reply : "No code changes were required for that request.";
    const replyBody = withMentionMarker(
      ensureMentionPrefix(action.reply || fallback, params.commentAuthor),
      params.commentId
    );
    await postMentionReply({
      client: params.client,
      commentId: params.commentId,
      body: replyBody,
      replyInThread: params.replyInThread
    });
    return { mode: "answer" };
  }

  const checks = await runMentionChecks({
    repoPath: params.repoPath,
    tools: params.repoTools
  }).catch((err) => {
    const message = err instanceof Error ? err.message : "mention verification failed";
    return {
      checks: {
        lint: { status: "error", summary: message, top_errors: [] },
        build: { status: "error", summary: message, top_errors: [] },
        test: { status: "error", summary: message, top_errors: [] }
      }
    } as MentionChecksOutput;
  });

  const commitMessage = sanitizeCommitMessage(action.commit_message, params.mentionTask);
  const changedFiles = await changedPaths(params.repoPath);
  const commitSha = await commitWorkingTree({
    repoPath: params.repoPath,
    message: commitMessage
  });
  await pushBranch({ repoPath: params.repoPath, branchName });

  const baseBranch = resolveFollowUpPrBaseBranch({
    pullRequestBaseRef: params.pullRequestBaseRef,
    refreshedBaseRef: params.refreshed.baseRef,
    repoDefaultBranch: params.repoDefaultBranch
  });

  const prTitle = action.pr_title?.trim() || defaultPrTitle(params.mentionTask);
  const prBody = renderPrBody({
    summary: action.summary,
    prBodyHint: action.pr_body,
    task: params.mentionTask,
    commentUrl: params.commentUrl,
    changedFiles,
    checks
  });

  let followUpPr: ProviderPullRequest | null = null;
  try {
    followUpPr = await params.client.createPullRequest({
      title: prTitle,
      body: prBody,
      head: branchName,
      base: baseBranch,
      draft: verificationFailedChecks(checks)
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (message.includes("already exists") && params.client.findOpenPullRequestByHead) {
      followUpPr = await params.client.findOpenPullRequestByHead({ head: branchName, base: baseBranch });
    }
    if (!followUpPr) {
      throw err;
    }
  }

  const prUrl = followUpPr.url || "";
  const prLink = prUrl ? prUrl : `#${followUpPr.number}`;
  const replyParts = [
    ensureMentionPrefix(action.reply, params.commentAuthor),
    `Opened follow-up PR: ${prLink}`,
    formatChecksForComment(checks)
  ];
  const replyBody = withMentionMarker(replyParts.join("\n\n"), params.commentId);
  await postMentionReply({
    client: params.client,
    commentId: params.commentId,
    body: replyBody,
    replyInThread: params.replyInThread
  });

  return {
    mode: "change_pr",
    prUrl,
    prNumber: followUpPr.number
  };
}

export async function processCommentReplyJob(data: CommentReplyJobData) {
  const {
    provider,
    installationId,
    repoId,
    pullRequestId,
    prNumber,
    commentId,
    commentBody,
    commentAuthor,
    commentUrl,
    replyInThread
  } =
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
    baseRef: pullRequest.baseRef || null,
    headRef: pullRequest.headRef || null,
    baseSha: pullRequest.baseSha || null,
    headSha: pullRequest.headSha || ""
  };
  const client = await adapter.createClient({
    installationId: installationId || null,
    repo: providerRepo,
    pullRequest: providerPull
  });
  const refreshed = await client.fetchPullRequest();

  const repoPath = await client.ensureRepoCheckout({ headSha: refreshed.headSha });
  const { config: fileRepoConfig, warnings } = await loadRepoConfig(repoPath);
  await saveRepoConfig(repo.id, fileRepoConfig, warnings);
  const memoryRules = await loadAcceptedRepoMemoryRules(repo.id);
  const repoConfig =
    memoryRules.length > 0
      ? { ...fileRepoConfig, rules: mergeRulesWithRepoMemory(fileRepoConfig.rules, memoryRules) }
      : fileRepoConfig;

  let diffPatch = "";
  let changedFiles: Array<{ path?: string; status?: string; additions?: number; deletions?: number; patch?: string | null }> = [];
  let localCompareSucceeded = false;

  if (refreshed.baseSha) {
    try {
      diffPatch = await buildLocalDiffPatch({
        repoPath,
        baseSha: refreshed.baseSha,
        headSha: refreshed.headSha
      });
      changedFiles = await buildLocalChangedFiles({
        repoPath,
        baseSha: refreshed.baseSha,
        headSha: refreshed.headSha
      });
      localCompareSucceeded = true;
      console.log(
        `[mention ${commentId}] using local git compare (${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"})`
      );
    } catch (err) {
      console.warn(`[mention ${commentId}] local git compare failed; falling back to provider API`, {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (!localCompareSucceeded) {
    try {
      diffPatch = await client.fetchDiffPatch();
    } catch {
      diffPatch = await buildLocalDiffPatch({
        repoPath,
        baseSha: refreshed.baseSha,
        headSha: refreshed.headSha
      });
    }
    changedFiles = await client.listChangedFiles();
  }

  const contextPack = await buildContextPack({
    repoId: repo.id,
    diffPatch,
    changedFiles: changedFiles as Array<{
      filename?: string;
      path?: string;
      status?: string;
      additions?: number;
      deletions?: number;
    }>,
    prTitle: refreshed.title || pullRequest.title,
    prBody: refreshed.body || pullRequest.body,
    retrieval: repoConfig.retrieval,
    graph: repoConfig.graph
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

  const { runDir, bundleDir, outDir, codexHomeDir } = await createReplyDirs(env.projectRoot, commentId);
  if (await isCompleted(runDir)) {
    console.log(`[mention ${commentId}] already completed; skipping`);
    return;
  }

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

  const mentionTask = extractMentionDoTask(commentBody, repoConfig);

  if (!mentionTask) {
    await runAnswerOnlyPath({
      repoPath,
      bundleDir,
      outDir,
      codexHomeDir,
      commentBody,
      commentAuthor,
      commentUrl,
      commentId,
      client,
      replyInThread,
      refreshedHeadSha: refreshed.headSha,
      repoId: repo.id,
      prNumber
    });
    await markCompleted(runDir, { mode: "answer", finishedAt: new Date().toISOString() });
    return;
  }

  const result = await runImplementPath({
    repoPath,
    bundleDir,
    outDir,
    codexHomeDir,
    commentBody,
    commentAuthor,
    commentUrl,
    commentId,
    mentionTask,
    client,
    refreshed,
    pullRequestBaseRef: pullRequest.baseRef || null,
    pullRequestHeadRef: pullRequest.headRef || null,
    repoDefaultBranch: repo.defaultBranch || null,
    repoTools: repoConfig.tools,
    replyInThread,
    repoId: repo.id,
    prNumber
  });

  await markCompleted(runDir, {
    mode: result.mode,
    prUrl: result.prUrl || null,
    prNumber: result.prNumber || null,
    finishedAt: new Date().toISOString()
  });
}
