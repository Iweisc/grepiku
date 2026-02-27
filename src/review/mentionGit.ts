import { execa } from "execa";

export function resolveFollowUpPrBaseBranch(params: {
  pullRequestBaseRef?: string | null;
  refreshedBaseRef?: string | null;
  repoDefaultBranch?: string | null;
}): string {
  return (
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
    .slice(0, 48);
}

export function mentionBranchName(commentId: string): string {
  const cleaned = sanitizeBranchSegment(commentId) || "task";
  return `grepiku/mention-${cleaned}-${Date.now().toString(36)}`;
}

export async function prepareMentionBranch(params: {
  repoPath: string;
  branchName: string;
  gitUserName: string;
  gitUserEmail: string;
}): Promise<void> {
  const { repoPath, branchName, gitUserName, gitUserEmail } = params;
  await execa("git", ["-C", repoPath, "switch", "--create", branchName], { stdio: "inherit" });
  await execa("git", ["-C", repoPath, "config", "user.name", gitUserName], { stdio: "inherit" });
  await execa("git", ["-C", repoPath, "config", "user.email", gitUserEmail], { stdio: "inherit" });
}

export async function hasWorkingTreeChanges(repoPath: string): Promise<boolean> {
  const { stdout } = await execa("git", ["-C", repoPath, "status", "--porcelain"], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  return stdout.trim().length > 0;
}

export async function changedPaths(repoPath: string): Promise<string[]> {
  const { stdout } = await execa("git", ["-C", repoPath, "diff", "--name-only"], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function commitWorkingTree(params: {
  repoPath: string;
  message: string;
}): Promise<string> {
  const message = params.message.trim() || "chore: apply grepiku requested changes";
  await execa("git", ["-C", params.repoPath, "add", "-A"], { stdio: "inherit" });
  await execa("git", ["-C", params.repoPath, "commit", "-m", message], { stdio: "inherit" });
  const { stdout } = await execa("git", ["-C", params.repoPath, "rev-parse", "HEAD"], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  return stdout.trim();
}

export async function pushBranch(params: {
  repoPath: string;
  branchName: string;
}): Promise<void> {
  await execa("git", ["-C", params.repoPath, "push", "origin", `HEAD:refs/heads/${params.branchName}`], {
    stdio: "inherit"
  });
}

export function isGitPermissionDeniedError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message} ${(error as { stack?: string }).stack || ""}`
      : String(error || "");
  const normalized = text.toLowerCase();
  const isKnownNonPermission403 =
    normalized.includes("rate limit") ||
    normalized.includes("secondary rate limit") ||
    normalized.includes("abuse detection");
  if (isKnownNonPermission403) return false;
  return (
    normalized.includes("permission to") && normalized.includes("denied") ||
    normalized.includes("resource not accessible by integration") ||
    normalized.includes("requested url returned error: 403") ||
    normalized.includes("http 403")
  );
}
