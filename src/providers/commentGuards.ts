const MENTION_REPLY_MARKER = /<!--\s*grepiku-mention:\s*[\w-]+\s*-->/i;
const TRUSTED_COMMENT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

type TrackedFeedbackComment = {
  providerCommentId?: string | null;
  finding?: {
    commentId?: string | null;
  } | null;
};

export function normalizeBotAwareLogin(login: string): string {
  return login.trim().toLowerCase().replace(/^app\//i, "").replace(/\[bot\]$/i, "");
}

export function isSelfBotComment(params: { authorLogin: string; botLogin: string }): boolean {
  const rawAuthor = params.authorLogin.trim();
  const author = normalizeBotAwareLogin(params.authorLogin);
  const bot = normalizeBotAwareLogin(params.botLogin);
  if (!author) return false;
  if (bot && author === bot) return true;
  if (bot) return false;
  return (/\[bot\]$/i.test(rawAuthor) || /^app\//i.test(rawAuthor)) && author.startsWith("grepiku");
}

export function isGeneratedMentionReply(body: string): boolean {
  return MENTION_REPLY_MARKER.test(body || "");
}

export function normalizeAuthorAssociation(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
}

function normalizeComparableLogin(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

export function isTrustedCommentAuthorAssociation(value: string | null | undefined): boolean {
  return TRUSTED_COMMENT_ASSOCIATIONS.has(normalizeAuthorAssociation(value));
}

export function isPullRequestAuthorComment(params: {
  commentAuthorExternalId?: string | null;
  commentAuthorLogin?: string | null;
  pullRequestAuthorExternalId?: string | null;
  pullRequestAuthorLogin?: string | null;
}): boolean {
  const commentAuthorExternalId = (params.commentAuthorExternalId || "").trim();
  const pullRequestAuthorExternalId = (params.pullRequestAuthorExternalId || "").trim();
  if (
    commentAuthorExternalId.length > 0 &&
    pullRequestAuthorExternalId.length > 0 &&
    commentAuthorExternalId === pullRequestAuthorExternalId
  ) {
    return true;
  }

  const commentAuthorLogin = normalizeComparableLogin(params.commentAuthorLogin);
  const pullRequestAuthorLogin = normalizeComparableLogin(params.pullRequestAuthorLogin);
  return (
    commentAuthorLogin.length > 0 &&
    pullRequestAuthorLogin.length > 0 &&
    commentAuthorLogin === pullRequestAuthorLogin
  );
}

export function isReviewThreadReplyAllowed(params: {
  hasTargetComment: boolean;
  trustedCommentAuthor: boolean;
  isPullRequestAuthor: boolean;
}): boolean {
  if (!params.hasTargetComment) {
    return false;
  }
  return params.trustedCommentAuthor || params.isPullRequestAuthor;
}

export function isPrivilegedCommentActionAllowed(params: {
  trigger: "review" | "mention" | null;
  mentionTask?: string | null;
  authorAssociation?: string | null;
}): boolean {
  if (params.trigger === "review") {
    return isTrustedCommentAuthorAssociation(params.authorAssociation);
  }
  if (params.trigger === "mention") {
    return isTrustedCommentAuthorAssociation(params.authorAssociation);
  }
  return true;
}

export function shouldCaptureRepoMemory(params: {
  trustedCommentAuthor: boolean;
  commentTrigger: "review" | "mention" | null;
  hasTargetComment: boolean;
}): boolean {
  if (!params.trustedCommentAuthor) {
    return false;
  }
  return params.hasTargetComment || params.commentTrigger === "mention";
}

export function resolveTrackedFeedbackCommentId(
  targetComment: TrackedFeedbackComment | null | undefined
): string | null {
  const findingCommentId = targetComment?.finding?.commentId?.trim();
  if (findingCommentId) {
    return findingCommentId;
  }

  const providerCommentId = targetComment?.providerCommentId?.trim();
  return providerCommentId || null;
}
