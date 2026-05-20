import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { execa } from "execa";
import { prisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import {
  loadRepoConfigAtGitRef,
  resolveRepoConfig as loadSavedRepoConfig,
  saveRepoConfig,
  type RepoConfig,
  type ToolConfig
} from "./config.js";
import { writeBundleFiles } from "./bundle.js";
import { buildMentionImplementPrompt, buildMentionPrompt } from "./prompts.js";
import { resolveCodexExecPath, runCodexStage } from "../runner/codexRunner.js";
import { readAndValidateJson, readAndValidateJsonWithFallback } from "./json.js";
import { MentionActionSchema, MentionChecksOutput, ReplySchema } from "./schemas.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderPullRequest, ProviderRepo } from "../providers/types.js";
import { buildContextPack } from "./context.js";
import { extractMentionDoTask } from "./triggers.js";
import { loadAcceptedRepoMemoryRules, mergeRulesWithRepoMemory } from "../services/repoMemory.js";
import {
  assertWorkspaceHasNoExternalSymlinks,
  createRepoCommandWorkspace
} from "./repoCommandWorkspace.js";
import {
  changedPaths,
  commitWorkingTree,
  hasWorkingTreeChanges,
  isGitPermissionDeniedError,
  mentionBranchName,
  prepareMentionBranch,
  pushBranch,
  resolveFollowUpPrBaseBranch
} from "./mentionGit.js";
import { resolveGithubBotLogin } from "../providers/github/adapter.js";
import { isTrustedCommentAuthorAssociation } from "../providers/commentGuards.js";
import { shouldRunVerifierForPullRequest } from "../providers/pullRequestGuards.js";
import {
  buildLocalChangedFiles,
  buildLocalDiffPatch,
  resolveDiffPatchAfterLocalCompareFailure
} from "./localCompare.js";
import { renderPrMarkdown } from "./prMarkdown.js";
import { sanitizeModelVisibleReviewData } from "./sensitiveReviewData.js";
import {
  runMentionChecksInKubernetes,
  shouldUseKubernetesSandbox
} from "../sandbox/k8sRunner.js";
import {
  neutralizeGitHubClosingKeywords,
  neutralizeGitHubIssueReferences,
  neutralizeGitHubMentions,
  sanitizeGitHubMarkdownText
} from "./githubMarkdown.js";
import { mergeStoredPullRequestState } from "./pullRequestState.js";

const env = loadEnv();
const SAFE_TOOL_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "TZ"
] as const;

type MentionToolResult = MentionChecksOutput["checks"]["lint"];
type SandboxedToolCommand = {
  command: string;
  args: string[];
  options: {
    argv0: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    shell: false;
  };
};

type MentionToolExecaOptions = {
  stdout: "ignore";
  stderr: "pipe";
  buffer: false;
  reject: false;
  timeout: number;
};

const SUPPRESSED_STDERR_MESSAGE = "stderr output suppressed for security";
const NON_LINUX_MENTION_TOOL_SUMMARY =
  "blocked: mention verification requires Linux sandbox support";
const GIT_METADATA_TAMPER_SUMMARY =
  "blocked: mention task modified worktree git metadata";
const MAX_REPO_GIT_METADATA_BYTES = 16 * 1024;
const MAX_FOLLOW_UP_COMMIT_MESSAGE_CHARS = 500;
const MAX_FOLLOW_UP_PR_TITLE_CHARS = 200;

function buildToolCommandEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  homeDir?: string
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of SAFE_TOOL_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value && value.trim().length > 0) {
      output[key] = value;
    }
  }
  if (homeDir && homeDir.trim().length > 0) {
    output.HOME = homeDir;
    output.XDG_CONFIG_HOME = path.join(homeDir, ".config");
    output.XDG_CACHE_HOME = path.join(homeDir, ".cache");
    output.XDG_STATE_HOME = path.join(homeDir, ".state");
    const tempDir = path.join(homeDir, ".tmp");
    output.TMPDIR = tempDir;
    output.TMP = tempDir;
    output.TEMP = tempDir;
  }
  return output;
}

function buildSandboxedToolCommand(params: {
  codexExecPath: string;
  repoPath: string;
  homeDir?: string;
  command: string;
  env?: NodeJS.ProcessEnv;
}): SandboxedToolCommand {
  const writableRoots = Array.from(
    new Set([params.repoPath, params.homeDir].filter((value): value is string => Boolean(value?.trim())))
  );
  const sandboxPolicy = JSON.stringify({
    type: "workspace-write",
    writable_roots: writableRoots,
    read_only_access: {
      type: "restricted",
      include_platform_defaults: true,
      readable_roots: []
    },
    network_access: false,
    exclude_tmpdir_env_var: true,
    exclude_slash_tmp: true
  });
  return {
    command: params.codexExecPath,
    args: [
      "--sandbox-policy-cwd",
      params.repoPath,
      "--sandbox-policy",
      sandboxPolicy,
      "--use-bwrap-sandbox",
      "--",
      "/bin/sh",
      "-lc",
      params.command
    ],
    options: {
      argv0: "codex-linux-sandbox",
      cwd: params.repoPath,
      env: params.env,
      shell: false
    }
  };
}

function buildMentionToolResult(params: {
  exitCode?: number | null;
  stderr?: string;
  timedOut: boolean;
  timeoutSec: number;
}): MentionToolResult {
  const hadStderr = Boolean(params.stderr && params.stderr.trim().length > 0);
  const topErrors =
    hadStderr && (params.timedOut || (params.exitCode ?? 1) !== 0)
      ? [SUPPRESSED_STDERR_MESSAGE]
      : [];

  if (params.timedOut) {
    return {
      status: "timeout",
      summary: `timed out after ${params.timeoutSec}s`,
      top_errors: topErrors
    };
  }

  const exitCode = Number.isInteger(params.exitCode) ? params.exitCode : 1;
  if (exitCode === 0) {
    return { status: "pass", summary: "success", top_errors: [] };
  }

  return {
    status: "fail",
    summary: `exited with ${exitCode}`,
    top_errors: topErrors
  };
}

function buildMentionToolExecaOptions(params: {
  timeoutSec: number;
}): MentionToolExecaOptions {
  return {
    stdout: "ignore",
    stderr: "pipe",
    buffer: false,
    reject: false,
    timeout: params.timeoutSec * 1000
  };
}

async function runMentionTool(params: {
  repoPath: string;
  toolName: "lint" | "build" | "test";
  toolConfig?: ToolConfig;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): Promise<MentionToolResult> {
  const { repoPath, toolConfig, homeDir } = params;
  if (!toolConfig?.cmd) {
    return { status: "skipped", summary: "not configured", top_errors: [] };
  }
  const platform = params.platform || process.platform;
  if (platform !== "linux") {
    return {
      status: "error",
      summary: NON_LINUX_MENTION_TOOL_SUMMARY,
      top_errors: []
    };
  }

  const timeoutSec = Math.max(1, Math.floor(toolConfig.timeout_sec || 600));
  let hadStderr = false;
  try {
    await assertWorkspaceHasNoExternalSymlinks(repoPath);
    const childEnv = buildToolCommandEnv(process.env, homeDir);
    if (homeDir) {
      await fs.mkdir(homeDir, { recursive: true });
      if (childEnv.TMPDIR) {
        await fs.mkdir(childEnv.TMPDIR, { recursive: true });
      }
      await assertWorkspaceHasNoExternalSymlinks(homeDir);
    }
    const result = await (async () => {
      const codexExecPath = await resolveCodexExecPath();
      const invocation = buildSandboxedToolCommand({
        codexExecPath,
        repoPath,
        homeDir,
        command: toolConfig.cmd,
        env: childEnv
      });
      const subprocess = execa(invocation.command, invocation.args, {
        ...invocation.options,
        ...buildMentionToolExecaOptions({
          timeoutSec
        })
      });
      subprocess.stderr?.on("data", () => {
        hadStderr = true;
      });
      return subprocess;
    })();
    return buildMentionToolResult({
      exitCode: result.exitCode,
      stderr: hadStderr ? SUPPRESSED_STDERR_MESSAGE : "",
      timedOut: false,
      timeoutSec
    });
  } catch (err: any) {
    if (err?.timedOut) {
      return buildMentionToolResult({
        exitCode: err?.exitCode,
        stderr: hadStderr ? SUPPRESSED_STDERR_MESSAGE : "",
        timedOut: true,
        timeoutSec
      });
    }
    const message = err instanceof Error ? err.message : "tool execution error";
    return { status: "error", summary: message, top_errors: [] };
  }
}

async function runMentionChecks(params: {
  repoPath: string;
  tools: RepoConfig["tools"];
  homeDir?: string;
}): Promise<MentionChecksOutput> {
  if (shouldUseKubernetesSandbox(env)) {
    const outDir = path.join(path.dirname(params.repoPath), "out");
    return runMentionChecksInKubernetes({
      repoPath: params.repoPath,
      tools: params.tools,
      outDir
    });
  }
  const lint = await runMentionTool({
    repoPath: params.repoPath,
    toolName: "lint",
    toolConfig: params.tools.lint,
    homeDir: params.homeDir
  });
  const build = await runMentionTool({
    repoPath: params.repoPath,
    toolName: "build",
    toolConfig: params.tools.build,
    homeDir: params.homeDir
  });
  const test = await runMentionTool({
    repoPath: params.repoPath,
    toolName: "test",
    toolConfig: params.tools.test,
    homeDir: params.homeDir
  });
  return { checks: { lint, build, test } };
}

function buildMentionSkippedChecks(summary: string): MentionChecksOutput {
  const result = {
    status: "skipped" as const,
    summary,
    top_errors: []
  };
  return {
    checks: {
      lint: { ...result },
      build: { ...result },
      test: { ...result }
    }
  };
}

function planMentionChecks(params: {
  repoFullName: string;
  pullRequest: Pick<ProviderPullRequest, "headRepoFullName" | "headSha">;
}): { shouldRun: boolean; skippedSummary: string | null } {
  const shouldRun = shouldRunVerifierForPullRequest({
    repoFullName: params.repoFullName,
    pullRequest: params.pullRequest
  });
  return shouldRun
    ? { shouldRun: true, skippedSummary: null }
    : { shouldRun: false, skippedSummary: "skipped for untrusted fork pull request" };
}

function planMentionImplementation(params: {
  repoFullName: string;
  pullRequest: Pick<ProviderPullRequest, "headRepoFullName" | "headSha">;
}): { shouldRun: boolean; deniedSummary: string | null } {
  const shouldRun = shouldRunVerifierForPullRequest({
    repoFullName: params.repoFullName,
    pullRequest: params.pullRequest
  });
  return shouldRun
    ? { shouldRun: true, deniedSummary: null }
    : { shouldRun: false, deniedSummary: "blocked for untrusted fork pull request" };
}

function resolveMentionExecutionMode(params: {
  mentionTask: string | null;
  commentAuthorAssociation?: string | null;
  repoFullName: string;
  pullRequest: Pick<ProviderPullRequest, "headRepoFullName" | "headSha">;
}): "answer" | "deny_untrusted_commenter" | "deny_untrusted_fork" | "implement" {
  if (!params.mentionTask) {
    return "answer";
  }
  if (!isTrustedCommentAuthorAssociation(params.commentAuthorAssociation)) {
    return "deny_untrusted_commenter";
  }
  const implementationPlan = planMentionImplementation({
    repoFullName: params.repoFullName,
    pullRequest: params.pullRequest
  });
  return implementationPlan.shouldRun ? "implement" : "deny_untrusted_fork";
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
  commentAuthorAssociation?: string | null;
  commentUrl?: string;
  replyInThread?: boolean;
  denyImplementation?: boolean;
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
  if (params.replyInThread && params.client.replyToComment) {
    try {
      await params.client.replyToComment({
        commentId: params.commentId,
        body: normalizedBody
      });
      return;
    } catch (err) {
      console.warn(`[mention ${params.commentId}] failed to post thread reply; falling back to summary comment`, {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  } else if (params.replyInThread && !params.client.replyToComment) {
    console.warn(
      `[mention ${params.commentId}] thread reply requested but provider does not support replyToComment; falling back to summary comment`
    );
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

async function resetReplyRunState(params: {
  bundleDir: string;
  outDir: string;
  codexHomeDir: string;
}): Promise<void> {
  await Promise.all([
    fs.rm(params.bundleDir, { recursive: true, force: true }),
    fs.rm(params.outDir, { recursive: true, force: true }),
    fs.rm(params.codexHomeDir, { recursive: true, force: true })
  ]);
  await fs.mkdir(params.bundleDir, { recursive: true });
  await fs.mkdir(params.outDir, { recursive: true });
  await fs.mkdir(params.codexHomeDir, { recursive: true });
  await fs.mkdir(path.join(params.bundleDir, "repo_hints"), { recursive: true });
}

type RepoGitMetadataState = {
  gitFilePath: string;
  content: string;
};

async function readRepoGitMetadataFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_REPO_GIT_METADATA_BYTES) {
      throw new Error(GIT_METADATA_TAMPER_SUMMARY);
    }
    const buffer = Buffer.alloc(MAX_REPO_GIT_METADATA_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_REPO_GIT_METADATA_BYTES) {
      throw new Error(GIT_METADATA_TAMPER_SUMMARY);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readRepoGitMetadataDirectoryDigest(dirPath: string): Promise<string> {
  const hash = crypto.createHash("sha256");

  async function visit(relativeDir: string): Promise<void> {
    const entries = await fs.readdir(path.join(dirPath, relativeDir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (!relativeDir && entry.name === "objects") {
        continue;
      }
      const relativePath = path.join(relativeDir, entry.name);
      const normalizedPath = relativePath.split(path.sep).join("/");
      const absolutePath = path.join(dirPath, relativePath);
      const stat = await fs.lstat(absolutePath);

      if (stat.isSymbolicLink()) {
        throw new Error(GIT_METADATA_TAMPER_SUMMARY);
      }
      if (stat.isDirectory()) {
        hash.update(`dir\0${normalizedPath}\0`);
        await visit(relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(GIT_METADATA_TAMPER_SUMMARY);
      }

      hash.update(`file\0${normalizedPath}\0${stat.size}\0`);
      if (stat.size <= MAX_REPO_GIT_METADATA_BYTES) {
        hash.update(await fs.readFile(absolutePath));
      } else {
        hash.update(`${stat.mtimeMs}\0${stat.ctimeMs}\0`);
      }
    }
  }

  await visit("");
  return `dir-sha256:${hash.digest("hex")}`;
}

async function captureRepoGitMetadataState(repoPath: string): Promise<RepoGitMetadataState> {
  const gitFilePath = path.join(repoPath, ".git");
  const stat = await fs.lstat(gitFilePath);
  if (stat.isFile()) {
    const content = await readRepoGitMetadataFile(gitFilePath);
    return { gitFilePath, content };
  }
  if (stat.isDirectory()) {
    const content = await readRepoGitMetadataDirectoryDigest(gitFilePath);
    return { gitFilePath, content };
  }
  throw new Error(GIT_METADATA_TAMPER_SUMMARY);
}

async function assertRepoGitMetadataUnchanged(
  repoPath: string,
  expected: RepoGitMetadataState
): Promise<void> {
  const current = await captureRepoGitMetadataState(repoPath);
  if (current.gitFilePath !== expected.gitFilePath || current.content !== expected.content) {
    throw new Error(GIT_METADATA_TAMPER_SUMMARY);
  }
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

function permissionDeniedReply(author: string): string {
  return ensureMentionPrefix(
    "I couldn't open a follow-up PR because this app token lacks repository write permissions (push/PR create was denied). Please grant the GitHub App `Contents: Read and write` and `Pull requests: Read and write`, then rerun the `do:` command.",
    author
  );
}

function untrustedMentionDoReply(author: string): string {
  return ensureMentionPrefix(
    "Only repository collaborators can use `@grepiku do:` to request code changes or a follow-up PR. Maintainers can still use `@grepiku` for questions without write actions.",
    author
  );
}

function untrustedForkMentionDoReply(author: string): string {
  return ensureMentionPrefix(
    "I can't open a follow-up PR from an untrusted fork pull request. Ask a collaborator to branch from this repository first, or use `@grepiku` for a read-only answer instead.",
    author
  );
}

function gitMetadataTamperReply(author: string): string {
  return ensureMentionPrefix(
    "I couldn't continue because the task modified `.git` metadata, which is blocked for safety. Please request source-file changes only.",
    author
  );
}

function defaultCommitMessage(task: string): string {
  const firstLine = task
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 52);
  if (!firstLine) return "chore: apply grepiku mention task";
  return `chore: ${firstLine}`;
}

function sanitizeGitHubNotificationText(value: string): string {
  return neutralizeGitHubIssueReferences(
    neutralizeGitHubClosingKeywords(neutralizeGitHubMentions(value.replace(/\r\n/g, "\n")))
  );
}

function sanitizeCommitMessage(value: string | undefined, task: string): string {
  const fallback = defaultCommitMessage(task);
  const normalized = (value || fallback)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 6)
    .join("\n")
    .trim();
  const bounded = normalized.slice(0, MAX_FOLLOW_UP_COMMIT_MESSAGE_CHARS).trim();
  const safe = sanitizeGitHubNotificationText(bounded);
  return safe || sanitizeGitHubNotificationText(fallback);
}

function defaultPrTitle(task: string): string {
  const summary = task
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 62);
  if (!summary) return "Grepiku follow-up changes";
  return `Grepiku: ${summary}`;
}

function sanitizePrTitle(value: string | undefined, task: string): string {
  const fallback = defaultPrTitle(task);
  const normalized = (value || fallback)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = normalized.slice(0, MAX_FOLLOW_UP_PR_TITLE_CHARS).trim();
  const safe = sanitizeGitHubNotificationText(bounded);
  return safe || sanitizeGitHubNotificationText(fallback);
}

function formatCheckLine(result: { status: string; summary: string }): string {
  return `${result.status} - ${sanitizeGitHubMarkdownText(result.summary)}`;
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
      ? params.changedFiles
          .map((item) => `- ${sanitizeGitHubMarkdownText(item)}`)
          .join("\n")
      : "- (no tracked file paths)";
  const bodyHint = params.prBodyHint?.trim();
  return [
    bodyHint ? sanitizeGitHubMarkdownText(bodyHint) : "",
    "## Request",
    sanitizeGitHubMarkdownText(params.task),
    "",
    "## Grepiku Summary",
    sanitizeGitHubMarkdownText(params.summary),
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
    prNumber: params.prNumber
  });

  const reply = await readAndValidateJsonWithFallback(
    path.join(params.outDir, "reply.json"),
    path.join(params.outDir, "last_message_reviewer.txt"),
    ReplySchema
  );
  const body = withMentionMarker(
    ensureMentionPrefix(sanitizeGitHubMarkdownText(reply.body), params.commentAuthor),
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
    pushBranch?: (params: { repoPath: string; branchName: string }) => Promise<void>;
  };
  refreshed: ProviderPullRequest;
  repoFullName: string;
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
  const initialGitMetadata = await captureRepoGitMetadataState(params.repoPath);

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

  try {
    await assertRepoGitMetadataUnchanged(params.repoPath, initialGitMetadata);
  } catch {
    const replyBody = withMentionMarker(
      gitMetadataTamperReply(params.commentAuthor),
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

  const action = await readAndValidateJson(
    path.join(params.outDir, "mention_action.json"),
    MentionActionSchema
  );

  const hasChanges = await hasWorkingTreeChanges(params.repoPath);
  if (!hasChanges || action.action !== "changed") {
    const fallback = action.action === "cannot_complete" ? action.reply : "No code changes were required for that request.";
    const replyBody = withMentionMarker(
      ensureMentionPrefix(
        sanitizeGitHubMarkdownText(action.reply || fallback),
        params.commentAuthor
      ),
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

  const checksPlan = planMentionChecks({
    repoFullName: params.repoFullName,
    pullRequest: params.refreshed
  });
  const checks = checksPlan.shouldRun
    ? await (async () => {
        const workspace = await createRepoCommandWorkspace({
          sourceRepoPath: params.repoPath,
          baseDir: path.join(env.projectRoot, "var", "mention-checks"),
          label: params.commentId
        });
        try {
          return await runMentionChecks({
            repoPath: workspace.repoPath,
            tools: params.repoTools,
            homeDir: workspace.homeDir
          });
        } finally {
          await workspace.cleanup().catch(() => undefined);
        }
      })().catch((err) => {
        const message = err instanceof Error ? err.message : "mention verification failed";
        return {
          checks: {
            lint: { status: "error", summary: message, top_errors: [] },
            build: { status: "error", summary: message, top_errors: [] },
            test: { status: "error", summary: message, top_errors: [] }
          }
        } as MentionChecksOutput;
      })
    : buildMentionSkippedChecks(checksPlan.skippedSummary || "skipped");

  const commitMessage = sanitizeCommitMessage(action.commit_message, params.mentionTask);
  const changedFiles = await changedPaths(params.repoPath);
  const commitSha = await commitWorkingTree({
    repoPath: params.repoPath,
    message: commitMessage
  });
  if (params.client.pushBranch) {
    await params.client.pushBranch({ repoPath: params.repoPath, branchName });
  } else {
    await pushBranch({ repoPath: params.repoPath, branchName });
  }

  const baseBranch = resolveFollowUpPrBaseBranch({
    pullRequestHeadRef: params.pullRequestHeadRef,
    pullRequestBaseRef: params.pullRequestBaseRef,
    refreshedHeadRef: params.refreshed.headRef,
    refreshedBaseRef: params.refreshed.baseRef,
    repoDefaultBranch: params.repoDefaultBranch
  });

  const prTitle = sanitizePrTitle(action.pr_title, params.mentionTask);
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
    ensureMentionPrefix(sanitizeGitHubMarkdownText(action.reply), params.commentAuthor),
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
    commentAuthorAssociation,
    commentUrl,
    replyInThread,
    denyImplementation
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

  if (denyImplementation) {
    const { runDir } = await createReplyDirs(env.projectRoot, commentId);
    if (await isCompleted(runDir)) {
      console.log(`[mention ${commentId}] already completed; skipping`);
      return;
    }

    const body = withMentionMarker(untrustedMentionDoReply(commentAuthor), commentId);
    await postMentionReply({
      client,
      commentId,
      body,
      replyInThread
    });
    await markCompleted(runDir, {
      mode: "answer",
      denied: true,
      reason: "untrusted_commenter",
      finishedAt: new Date().toISOString()
    });
    return;
  }

  const refreshed = await client.fetchPullRequest();
  const refreshedPullRequestState = mergeStoredPullRequestState(
    {
      title: pullRequest.title,
      body: pullRequest.body,
      url: pullRequest.url,
      state: pullRequest.state,
      baseRef: pullRequest.baseRef,
      headRef: pullRequest.headRef,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      draft: pullRequest.draft
    },
    refreshed
  );
  await prisma.pullRequest.update({
    where: { id: pullRequest.id },
    data: {
      title: refreshedPullRequestState.title,
      body: refreshedPullRequestState.body,
      url: refreshedPullRequestState.url,
      state: refreshedPullRequestState.state,
      baseRef: refreshedPullRequestState.baseRef,
      headRef: refreshedPullRequestState.headRef,
      baseSha: refreshedPullRequestState.baseSha,
      headSha: refreshedPullRequestState.headSha,
      draft: refreshedPullRequestState.draft
    }
  });
  const savedRepoConfig = await loadSavedRepoConfig(repo.id);
  const queuedMentionTask = extractMentionDoTask(commentBody, savedRepoConfig);
  const implementationPlan = queuedMentionTask
    ? planMentionImplementation({
        repoFullName: repo.fullName,
        pullRequest: refreshed
      })
    : null;
  if (queuedMentionTask && implementationPlan && !implementationPlan.shouldRun) {
    const { runDir } = await createReplyDirs(env.projectRoot, commentId);
    if (await isCompleted(runDir)) {
      console.log(`[mention ${commentId}] already completed; skipping`);
      return;
    }

    const body = withMentionMarker(untrustedForkMentionDoReply(commentAuthor), commentId);
    await postMentionReply({
      client,
      commentId,
      body,
      replyInThread
    });
    await markCompleted(runDir, {
      mode: "answer",
      denied: true,
      reason: "untrusted_fork_pull_request",
      finishedAt: new Date().toISOString()
    });
    return;
  }

  const repoPath = await client.ensureRepoCheckout({ headSha: refreshed.headSha });
  const { config: trustedRepoConfig, warnings } = await loadRepoConfigAtGitRef(
    repoPath,
    refreshed.baseSha || pullRequest.baseSha || null
  );
  await saveRepoConfig(repo.id, trustedRepoConfig, warnings);
  const memoryRules = await loadAcceptedRepoMemoryRules(repo.id);
  const repoConfig =
    memoryRules.length > 0
      ? { ...trustedRepoConfig, rules: mergeRulesWithRepoMemory(trustedRepoConfig.rules, memoryRules) }
      : trustedRepoConfig;

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
    diffPatch = await resolveDiffPatchAfterLocalCompareFailure({
      fetchProviderDiff: () => client.fetchDiffPatch(),
      buildLocalDiff: () =>
        buildLocalDiffPatch({
          repoPath,
          baseSha: refreshed.baseSha,
          headSha: refreshed.headSha
        })
    });
    changedFiles = await client.listChangedFiles();
  }

  const modelVisibleReviewData = sanitizeModelVisibleReviewData({
    diffPatch,
    changedFiles
  });
  diffPatch = modelVisibleReviewData.diffPatch;
  changedFiles = modelVisibleReviewData.changedFiles;
  if (modelVisibleReviewData.sensitivePaths.length > 0) {
    console.log(
      `[mention ${commentId}] withheld ${modelVisibleReviewData.sensitivePaths.length} sensitive changed path(s) from model-visible context`
    );
  }

  const contextPack = await buildContextPack({
    repoId: repo.id,
    diffPatch,
    repoPath,
    headSha: refreshedPullRequestState.headSha,
    changedFiles: changedFiles as Array<{
      filename?: string;
      path?: string;
      status?: string;
      additions?: number;
      deletions?: number;
    }>,
    prTitle: refreshedPullRequestState.title,
    prBody: refreshedPullRequestState.body,
    retrieval: repoConfig.retrieval,
    graph: repoConfig.graph
  });

  const prMarkdown = renderPrMarkdown({
    title: refreshedPullRequestState.title || "Untitled",
    number: prNumber,
    author: refreshed.author?.login || "unknown",
    body: refreshedPullRequestState.body,
    baseRef: refreshedPullRequestState.baseRef,
    headRef: refreshedPullRequestState.headRef,
    headSha: refreshedPullRequestState.headSha,
    url: refreshedPullRequestState.url,
    sensitivePathsWithheld: modelVisibleReviewData.sensitivePaths
  });

  const { runDir, bundleDir, outDir, codexHomeDir } = await createReplyDirs(env.projectRoot, commentId);
  if (await isCompleted(runDir)) {
    console.log(`[mention ${commentId}] already completed; skipping`);
    return;
  }
  const lockPath = path.join(runDir, "in_progress.lock");
  const lockHandle = await fs.open(lockPath, "wx").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "EEXIST") {
      return null;
    }
    throw err;
  });
  if (!lockHandle) {
    console.log(`[mention ${commentId}] already running; skipping`);
    return;
  }

  try {
    await resetReplyRunState({ bundleDir, outDir, codexHomeDir });

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
    const mentionExecutionMode = resolveMentionExecutionMode({
      mentionTask,
      commentAuthorAssociation,
      repoFullName: repo.fullName,
      pullRequest: refreshed
    });

  if (mentionExecutionMode === "deny_untrusted_commenter") {
    const body = withMentionMarker(untrustedMentionDoReply(commentAuthor), commentId);
    await postMentionReply({
      client,
      commentId,
      body,
      replyInThread
    });
    await markCompleted(runDir, {
      mode: "answer",
      denied: true,
      reason: "untrusted_commenter",
      finishedAt: new Date().toISOString()
    });
    return;
  }

  if (mentionExecutionMode === "deny_untrusted_fork") {
    const body = withMentionMarker(untrustedForkMentionDoReply(commentAuthor), commentId);
    await postMentionReply({
      client,
      commentId,
      body,
      replyInThread
    });
    await markCompleted(runDir, {
      mode: "answer",
      denied: true,
      reason: "untrusted_fork_pull_request",
      finishedAt: new Date().toISOString()
    });
    return;
  }

  if (mentionExecutionMode === "answer") {
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

  if (!mentionTask) {
    throw new Error("mention task missing after trusted execution planning");
  }

  try {
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
      repoFullName: repo.fullName,
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
  } catch (error) {
    if (!isGitPermissionDeniedError(error)) throw error;

    const body = withMentionMarker(permissionDeniedReply(commentAuthor), commentId);
    await postMentionReply({
      client,
      commentId,
      body,
      replyInThread
    });
    await markCompleted(runDir, {
      mode: "answer",
      permissionDenied: true,
      finishedAt: new Date().toISOString()
    });
  }
  } finally {
    await lockHandle.close();
    await fs.rm(lockPath, { force: true });
  }
}

export const __mentionInternals = {
  renderPrBody,
  postMentionReply,
  planMentionChecks,
  planMentionImplementation,
  resolveMentionExecutionMode,
  sanitizeCommitMessage,
  sanitizePrTitle,
  buildToolCommandEnv,
  buildSandboxedToolCommand,
  buildMentionToolExecaOptions,
  buildMentionToolResult,
  runMentionTool,
  resetReplyRunState,
  captureRepoGitMetadataState,
  assertRepoGitMetadataUnchanged
};
