import { isSelfBotComment } from "./commentGuards.js";
import type { ProviderPullRequest } from "./types.js";

type PullRequestBranchCleanupCandidate = Pick<
  ProviderPullRequest,
  "state" | "headRef" | "headRepoFullName" | "author"
>;

type PullRequestReviewSkipCandidate = Pick<
  ProviderPullRequest,
  "headRef" | "author"
>;

type PullRequestVerifierCandidate = Pick<
  ProviderPullRequest,
  "headRepoFullName"
>;

const FOLLOW_UP_BRANCH_PREFIX = "grepiku/mention-";

const REVIEWABLE_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize"
]);

export function shouldDeleteClosedBotPrBranch(params: {
  action: string;
  repoFullName: string;
  pullRequest: PullRequestBranchCleanupCandidate;
  botLogin: string;
}): boolean {
  if (!params.botLogin.trim()) return false;
  if (params.action !== "closed") return false;
  if (params.pullRequest.state !== "closed") return false;
  const headRef = params.pullRequest.headRef?.trim() || "";
  if (!headRef) return false;
  if (!headRef.startsWith(FOLLOW_UP_BRANCH_PREFIX)) return false;

  const authorLogin = params.pullRequest.author?.login || "";
  if (!isSelfBotComment({ authorLogin, botLogin: params.botLogin })) {
    return false;
  }

  const headRepoFullName = params.pullRequest.headRepoFullName?.trim().toLowerCase();
  const repoFullName = params.repoFullName.trim().toLowerCase();
  if (!headRepoFullName || !repoFullName || headRepoFullName !== repoFullName) {
    return false;
  }

  return true;
}

export function shouldSkipSelfBotFollowUpPrReview(params: {
  action: string;
  pullRequest: PullRequestReviewSkipCandidate;
  botLogin: string;
}): boolean {
  if (!params.botLogin.trim()) return false;
  if (!REVIEWABLE_PULL_REQUEST_ACTIONS.has(params.action)) return false;

  const headRef = params.pullRequest.headRef?.trim() || "";
  if (!headRef.startsWith(FOLLOW_UP_BRANCH_PREFIX)) return false;

  const authorLogin = params.pullRequest.author?.login || "";
  return isSelfBotComment({ authorLogin, botLogin: params.botLogin });
}

export function shouldSkipReviewForSelfAuthoredPullRequest(params: {
  pullRequest: PullRequestReviewSkipCandidate;
  botLogin: string;
}): boolean {
  const authorLogin = params.pullRequest.author?.login || "";
  if (params.botLogin.trim() && isSelfBotComment({ authorLogin, botLogin: params.botLogin })) {
    return true;
  }

  const headRef = params.pullRequest.headRef?.trim() || "";
  return headRef.startsWith(FOLLOW_UP_BRANCH_PREFIX) && (/\[bot\]$/i.test(authorLogin.trim()) || /^app\//i.test(authorLogin.trim()));
}

export function shouldSkipBotAuthoredReview(params: {
  action: string;
  pullRequest: PullRequestReviewSkipCandidate;
  botLogin: string;
}): boolean {
  if (!REVIEWABLE_PULL_REQUEST_ACTIONS.has(params.action)) return false;
  return shouldSkipReviewForSelfAuthoredPullRequest(params);
}

export function shouldRunVerifierForPullRequest(params: {
  repoFullName: string;
  pullRequest: PullRequestVerifierCandidate;
}): boolean {
  const repoFullName = params.repoFullName.trim().toLowerCase();
  const headRepoFullName = params.pullRequest.headRepoFullName?.trim().toLowerCase() || "";
  if (!repoFullName || !headRepoFullName) {
    return false;
  }
  return headRepoFullName === repoFullName;
}

export function headCommitReviewSkipReason(params: {
  commitMessage: string;
  authorLogin?: string | null;
  parentCount?: number | null;
  botLogin: string;
}): string | null {
  if (!params.botLogin.trim()) {
    return null;
  }
  const authorLogin = params.authorLogin || "";
  if (isSelfBotComment({ authorLogin, botLogin: params.botLogin })) {
    return "bot-commit";
  }
  return null;
}
