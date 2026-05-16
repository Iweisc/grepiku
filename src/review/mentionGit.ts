import crypto from "crypto";
import { execa } from "execa";
import { gitCheckoutSafetyEnv } from "../github/gitAuth.js";
import { normalizePath } from "./diff.js";

export function resolveFollowUpPrBaseBranch(params: {
  pullRequestHeadRef?: string | null;
  pullRequestBaseRef?: string | null;
  refreshedHeadRef?: string | null;
  refreshedBaseRef?: string | null;
  repoDefaultBranch?: string | null;
}): string {
  return (
    params.pullRequestHeadRef ||
    params.refreshedHeadRef ||
    params.pullRequestBaseRef ||
    params.refreshedBaseRef ||
    params.repoDefaultBranch ||
    "main"
  );
}

function sanitizeBranchSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);
}

export function mentionBranchName(commentId: string): string {
  const cleaned = sanitizeBranchSegment(commentId) || "task";
  const suffix = crypto.createHash("sha1").update(commentId).digest("hex").slice(0, 8);
  return `grepiku/mention-${cleaned}-${suffix}`;
}

export async function prepareMentionBranch(params: {
  repoPath: string;
  branchName: string;
  gitUserName: string;
  gitUserEmail: string;
}): Promise<void> {
  const { repoPath, gitUserName, gitUserEmail } = params;
  const env = gitCheckoutSafetyEnv();
  await execa("git", ["-C", repoPath, "switch", "--detach"], { stdio: "inherit", env });
  await execa("git", ["-C", repoPath, "config", "user.name", gitUserName], { stdio: "inherit", env });
  await execa("git", ["-C", repoPath, "config", "user.email", gitUserEmail], { stdio: "inherit", env });
}

export async function hasWorkingTreeChanges(repoPath: string): Promise<boolean> {
  const { stdout } = await execa("git", ["-C", repoPath, "status", "--porcelain"], {
    stdio: ["ignore", "pipe", "ignore"],
    env: gitCheckoutSafetyEnv()
  });
  return stdout.trim().length > 0;
}

export async function changedPaths(repoPath: string): Promise<string[]> {
  const { stdout } = await execa("git", ["-C", repoPath, "diff", "--no-ext-diff", "--name-only", "-z"], {
    stdio: ["ignore", "pipe", "ignore"],
    env: gitCheckoutSafetyEnv()
  });
  return stdout
    .split("\0")
    .map((line) => normalizePath(line))
    .filter((line) => line.length > 0);
}

export async function commitWorkingTree(params: {
  repoPath: string;
  message: string;
}): Promise<string> {
  const message = params.message.trim() || "chore: apply grepiku requested changes";
  const env = gitCheckoutSafetyEnv();
  await execa("git", ["-C", params.repoPath, "add", "-A"], { stdio: "inherit", env });
  await execa("git", ["-C", params.repoPath, "commit", "-m", message], { stdio: "inherit", env });
  const { stdout } = await execa("git", ["-C", params.repoPath, "rev-parse", "HEAD"], {
    stdio: ["ignore", "pipe", "ignore"],
    env
  });
  return stdout.trim();
}

export async function pushBranch(params: {
  repoPath: string;
  branchName: string;
}): Promise<void> {
  await execa("git", ["-C", params.repoPath, "push", "origin", `HEAD:refs/heads/${params.branchName}`], {
    stdio: "inherit",
    env: gitCheckoutSafetyEnv()
  });
}

export function isGitPermissionDeniedError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message} ${(error as { stack?: string }).stack || ""}`
      : String(error || "");
  const normalized = text.toLowerCase();
  return (
    normalized.includes("permission to") && normalized.includes("denied") ||
    normalized.includes("resource not accessible by integration") ||
    normalized.includes("requested url returned error: 403") ||
    normalized.includes("http 403")
  );
}
