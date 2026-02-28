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
  if (!REVIEWABLE_PULL_REQUEST_ACTIONS.has(params.action)) return false;

  const headRef = params.pullRequest.headRef?.trim() || "";
  if (!headRef.startsWith(FOLLOW_UP_BRANCH_PREFIX)) return false;

  const authorLogin = params.pullRequest.author?.login || "";
  return isSelfBotComment({ authorLogin, botLogin: params.botLogin });
}
