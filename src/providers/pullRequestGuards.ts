import { isSelfBotComment } from "./commentGuards.js";
import type { ProviderPullRequest } from "./types.js";

type PullRequestBranchCleanupCandidate = Pick<
  ProviderPullRequest,
  "state" | "headRef" | "headRepoFullName" | "author"
>;

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
  if (!headRef.startsWith("grepiku/mention-")) return false;

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
