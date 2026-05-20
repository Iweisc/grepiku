import test from "node:test";
import assert from "node:assert/strict";
import {
  isGeneratedMentionReply,
  isPullRequestAuthorComment,
  isPrivilegedCommentActionAllowed,
  isReviewThreadReplyAllowed,
  resolveTrackedFeedbackCommentId,
  shouldCaptureRepoMemory,
  isSelfBotComment,
  isTrustedCommentAuthorAssociation,
  normalizeBotAwareLogin
} from "../src/providers/commentGuards.js";
import { isResolutionReply } from "../src/providers/commentResolution.js";
import {
  headCommitReviewSkipReason,
  shouldDeleteClosedBotPrBranch,
  shouldRunVerifierForPullRequest,
  shouldSkipBotAuthoredReview,
  shouldSkipReviewForSelfAuthoredPullRequest,
  shouldSkipSelfBotFollowUpPrReview
} from "../src/providers/pullRequestGuards.js";
import {
  selectBootstrapIndexSha,
  selectTrustedPullRequestIndexSha
} from "../src/providers/bootstrapIndex.js";

test("normalizeBotAwareLogin strips app/ and [bot] wrappers", () => {
  assert.equal(normalizeBotAwareLogin("grepiku-dev[bot]"), "grepiku-dev");
  assert.equal(normalizeBotAwareLogin("app/grepiku-dev"), "grepiku-dev");
  assert.equal(normalizeBotAwareLogin("grepiku-dev"), "grepiku-dev");
});

test("isSelfBotComment matches bot login with [bot] or app/ wrappers", () => {
  assert.equal(
    isSelfBotComment({
      authorLogin: "grepiku-dev[bot]",
      botLogin: "grepiku-dev"
    }),
    true
  );
  assert.equal(
    isSelfBotComment({
      authorLogin: "app/grepiku-dev",
      botLogin: "grepiku-dev"
    }),
    true
  );
  assert.equal(
    isSelfBotComment({
      authorLogin: "grepiku-dev",
      botLogin: "grepiku-dev[bot]"
    }),
    true
  );
});

test("isSelfBotComment does not match unrelated bots or users", () => {
  assert.equal(
    isSelfBotComment({
      authorLogin: "dependabot[bot]",
      botLogin: "grepiku-dev"
    }),
    false
  );
  assert.equal(
    isSelfBotComment({
      authorLogin: "grepiku-helper[bot]",
      botLogin: "grepiku-dev"
    }),
    false
  );
  assert.equal(
    isSelfBotComment({
      authorLogin: "Iweisc",
      botLogin: "grepiku-dev"
    }),
    false
  );
});

test("isGeneratedMentionReply detects mention marker only", () => {
  assert.equal(isGeneratedMentionReply("<!-- grepiku-mention:2862044956 -->\n@grepiku-dev[bot] ok"), true);
  assert.equal(isGeneratedMentionReply("<!-- grepiku:cmt-1 -->"), false);
});

test("isTrustedCommentAuthorAssociation allows maintainers and rejects untrusted commenters", () => {
  assert.equal(isTrustedCommentAuthorAssociation("OWNER"), true);
  assert.equal(isTrustedCommentAuthorAssociation("member"), true);
  assert.equal(isTrustedCommentAuthorAssociation("COLLABORATOR"), true);
  assert.equal(isTrustedCommentAuthorAssociation("CONTRIBUTOR"), false);
  assert.equal(isTrustedCommentAuthorAssociation("FIRST_TIME_CONTRIBUTOR"), false);
  assert.equal(isTrustedCommentAuthorAssociation(""), false);
  assert.equal(isTrustedCommentAuthorAssociation(undefined), false);
});

test("isPrivilegedCommentActionAllowed only allows trusted commenters to trigger standalone bot actions", () => {
  assert.equal(
    isPrivilegedCommentActionAllowed({
      trigger: "review",
      mentionTask: null,
      authorAssociation: "OWNER"
    }),
    true
  );
  assert.equal(
    isPrivilegedCommentActionAllowed({
      trigger: "review",
      mentionTask: null,
      authorAssociation: "CONTRIBUTOR"
    }),
    false
  );
  assert.equal(
    isPrivilegedCommentActionAllowed({
      trigger: "mention",
      mentionTask: "apply the requested fix",
      authorAssociation: "COLLABORATOR"
    }),
    true
  );
  assert.equal(
    isPrivilegedCommentActionAllowed({
      trigger: "mention",
      mentionTask: "apply the requested fix",
      authorAssociation: "FIRST_TIME_CONTRIBUTOR"
    }),
    false
  );
  assert.equal(
    isPrivilegedCommentActionAllowed({
      trigger: "mention",
      mentionTask: null,
      authorAssociation: "FIRST_TIME_CONTRIBUTOR"
    }),
    false
  );
});

test("isPullRequestAuthorComment matches the PR author by external id or login", () => {
  assert.equal(
    isPullRequestAuthorComment({
      commentAuthorExternalId: "101",
      commentAuthorLogin: "contributor",
      pullRequestAuthorExternalId: "101",
      pullRequestAuthorLogin: "someone-else"
    }),
    true
  );
  assert.equal(
    isPullRequestAuthorComment({
      commentAuthorExternalId: "202",
      commentAuthorLogin: "ContribUser",
      pullRequestAuthorExternalId: "999",
      pullRequestAuthorLogin: "contribuser"
    }),
    true
  );
  assert.equal(
    isPullRequestAuthorComment({
      commentAuthorExternalId: "202",
      commentAuthorLogin: "outsider",
      pullRequestAuthorExternalId: "999",
      pullRequestAuthorLogin: "contribuser"
    }),
    false
  );
});

test("isReviewThreadReplyAllowed only allows trusted collaborators or the PR author", () => {
  assert.equal(
    isReviewThreadReplyAllowed({
      hasTargetComment: true,
      trustedCommentAuthor: true,
      isPullRequestAuthor: false
    }),
    true
  );
  assert.equal(
    isReviewThreadReplyAllowed({
      hasTargetComment: true,
      trustedCommentAuthor: false,
      isPullRequestAuthor: true
    }),
    true
  );
  assert.equal(
    isReviewThreadReplyAllowed({
      hasTargetComment: true,
      trustedCommentAuthor: false,
      isPullRequestAuthor: false
    }),
    false
  );
  assert.equal(
    isReviewThreadReplyAllowed({
      hasTargetComment: false,
      trustedCommentAuthor: true,
      isPullRequestAuthor: true
    }),
    false
  );
});

test("shouldCaptureRepoMemory requires a trusted commenter for mention-driven memory suggestions", () => {
  assert.equal(
    shouldCaptureRepoMemory({
      trustedCommentAuthor: false,
      commentTrigger: "mention",
      hasTargetComment: false
    }),
    false
  );
  assert.equal(
    shouldCaptureRepoMemory({
      trustedCommentAuthor: true,
      commentTrigger: "mention",
      hasTargetComment: false
    }),
    true
  );
  assert.equal(
    shouldCaptureRepoMemory({
      trustedCommentAuthor: true,
      commentTrigger: null,
      hasTargetComment: true
    }),
    true
  );
});

test("resolveTrackedFeedbackCommentId only accepts tracked Grepiku review comments", () => {
  assert.equal(
    resolveTrackedFeedbackCommentId({
      providerCommentId: "github-inline-comment-1",
      finding: { commentId: "finding-comment-1" }
    }),
    "finding-comment-1"
  );
  assert.equal(
    resolveTrackedFeedbackCommentId({
      providerCommentId: "github-summary-comment-9",
      finding: null
    }),
    "github-summary-comment-9"
  );
  assert.equal(resolveTrackedFeedbackCommentId(null), null);
  assert.equal(
    resolveTrackedFeedbackCommentId({
      providerCommentId: "   ",
      finding: null
    }),
    null
  );
});

test("isResolutionReply ignores negated resolution phrases", () => {
  assert.equal(isResolutionReply("fixed in latest commit"), true);
  assert.equal(isResolutionReply("not done yet, still debugging"), false);
  assert.equal(isResolutionReply("this isn't resolved"), false);
});

test("shouldDeleteClosedBotPrBranch allows deleting closed self-bot branches in same repo", () => {
  assert.equal(
    shouldDeleteClosedBotPrBranch({
      action: "closed",
      repoFullName: "acme/grepiku",
      botLogin: "grepiku-dev",
      pullRequest: {
        state: "closed",
        headRef: "grepiku/mention-123",
        headRepoFullName: "acme/grepiku",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    true
  );
});

test("shouldDeleteClosedBotPrBranch rejects non-bot, open, and fork branches", () => {
  assert.equal(
    shouldDeleteClosedBotPrBranch({
      action: "closed",
      repoFullName: "acme/grepiku",
      botLogin: "grepiku-dev",
      pullRequest: {
        state: "closed",
        headRef: "feature/refactor",
        headRepoFullName: "acme/grepiku",
        author: { login: "octocat", externalId: "2" }
      }
    }),
    false
  );
  assert.equal(
    shouldDeleteClosedBotPrBranch({
      action: "synchronize",
      repoFullName: "acme/grepiku",
      botLogin: "grepiku-dev",
      pullRequest: {
        state: "open",
        headRef: "grepiku/mention-123",
        headRepoFullName: "acme/grepiku",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    false
  );
  assert.equal(
    shouldDeleteClosedBotPrBranch({
      action: "closed",
      repoFullName: "acme/grepiku",
      botLogin: "grepiku-dev",
      pullRequest: {
        state: "closed",
        headRef: "grepiku/mention-123",
        headRepoFullName: "fork-user/grepiku",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    false
  );
  assert.equal(
    shouldDeleteClosedBotPrBranch({
      action: "closed",
      repoFullName: "acme/grepiku",
      botLogin: "grepiku-dev",
      pullRequest: {
        state: "closed",
        headRef: "grepiku/manual-fix",
        headRepoFullName: "acme/grepiku",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    false
  );
  assert.equal(
    shouldDeleteClosedBotPrBranch({
      action: "closed",
      repoFullName: "acme/grepiku",
      botLogin: "grepiku-dev",
      pullRequest: {
        state: "closed",
        headRef: "grepiku/mention-123",
        headRepoFullName: null,
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    false
  );
});

test("shouldSkipSelfBotFollowUpPrReview skips bot-authored follow-up pull requests", () => {
  assert.equal(
    shouldSkipSelfBotFollowUpPrReview({
      action: "opened",
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "grepiku/mention-123",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    true
  );
  assert.equal(
    shouldSkipSelfBotFollowUpPrReview({
      action: "synchronize",
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "grepiku/mention-123",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    true
  );
});

test("shouldSkipSelfBotFollowUpPrReview does not skip non-follow-up or non-bot pull requests", () => {
  assert.equal(
    shouldSkipSelfBotFollowUpPrReview({
      action: "opened",
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "feature/refactor",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    false
  );
  assert.equal(
    shouldSkipSelfBotFollowUpPrReview({
      action: "opened",
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "grepiku/mention-123",
        author: { login: "octocat", externalId: "2" }
      }
    }),
    false
  );
  assert.equal(
    shouldSkipSelfBotFollowUpPrReview({
      action: "edited",
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "grepiku/mention-123",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    false
  );
});

test("shouldSkipSelfBotFollowUpPrReview fails closed when bot identity cannot be resolved", () => {
  assert.equal(
    shouldSkipSelfBotFollowUpPrReview({
      action: "opened",
      botLogin: "",
      pullRequest: {
        headRef: "grepiku/mention-123",
        author: { login: "grepiku-helper[bot]", externalId: "1" }
      }
    }),
    false
  );
});

test("shouldSkipReviewForSelfAuthoredPullRequest skips bot-authored PRs regardless of enqueue path", () => {
  assert.equal(
    shouldSkipReviewForSelfAuthoredPullRequest({
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "feature/some-branch",
        author: { login: "app/grepiku-dev", externalId: "1" }
      }
    }),
    true
  );
});

test("shouldSkipReviewForSelfAuthoredPullRequest falls back to follow-up branch pattern for app-authored mention PRs", () => {
  assert.equal(
    shouldSkipReviewForSelfAuthoredPullRequest({
      botLogin: "",
      pullRequest: {
        headRef: "grepiku/mention-123",
        author: { login: "app/grepiku-dev", externalId: "1" }
      }
    }),
    true
  );
  assert.equal(
    shouldSkipReviewForSelfAuthoredPullRequest({
      botLogin: "",
      pullRequest: {
        headRef: "grepiku/mention-123",
        author: { login: "octocat", externalId: "2" }
      }
    }),
    false
  );
});

test("shouldSkipBotAuthoredReview skips any PR authored by the bot", () => {
  assert.equal(
    shouldSkipBotAuthoredReview({
      action: "opened",
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "feature/some-branch",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    true
  );
  assert.equal(
    shouldSkipBotAuthoredReview({
      action: "synchronize",
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "grepiku/mention-123",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    true
  );
});

test("shouldSkipBotAuthoredReview fails closed when bot identity cannot be resolved", () => {
  assert.equal(
    shouldSkipBotAuthoredReview({
      action: "opened",
      botLogin: "",
      pullRequest: {
        headRef: "feature/some-branch",
        author: { login: "grepiku-helper[bot]", externalId: "1" }
      }
    }),
    false
  );
});

test("shouldSkipBotAuthoredReview does not skip human-authored PRs", () => {
  assert.equal(
    shouldSkipBotAuthoredReview({
      action: "opened",
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "feature/refactor",
        author: { login: "octocat", externalId: "2" }
      }
    }),
    false
  );
  assert.equal(
    shouldSkipBotAuthoredReview({
      action: "edited",
      botLogin: "grepiku-dev",
      pullRequest: {
        headRef: "feature/refactor",
        author: { login: "grepiku-dev[bot]", externalId: "1" }
      }
    }),
    false
  );
});

test("shouldDeleteClosedBotPrBranch fails closed when bot identity cannot be resolved", () => {
  assert.equal(
    shouldDeleteClosedBotPrBranch({
      action: "closed",
      repoFullName: "acme/grepiku",
      botLogin: "",
      pullRequest: {
        state: "closed",
        headRef: "grepiku/mention-123",
        headRepoFullName: "acme/grepiku",
        author: { login: "grepiku-helper[bot]", externalId: "1" }
      }
    }),
    false
  );
});

test("shouldRunVerifierForPullRequest only allows same-repo heads", () => {
  assert.equal(
    shouldRunVerifierForPullRequest({
      repoFullName: "acme/grepiku",
      pullRequest: {
        headRepoFullName: "acme/grepiku"
      }
    }),
    true
  );
  assert.equal(
    shouldRunVerifierForPullRequest({
      repoFullName: "acme/grepiku",
      pullRequest: {
        headRepoFullName: "fork-user/grepiku"
      }
    }),
    false
  );
  assert.equal(
    shouldRunVerifierForPullRequest({
      repoFullName: "acme/grepiku",
      pullRequest: {
        headRepoFullName: null
      }
    }),
    false
  );
});

test("headCommitReviewSkipReason only skips self-bot synchronize commits", () => {
  assert.equal(
    headCommitReviewSkipReason({
      commitMessage: "Apply suggestions from code review",
      authorLogin: "octocat",
      parentCount: 1,
      botLogin: "grepiku-dev"
    }),
    null
  );

  assert.equal(
    headCommitReviewSkipReason({
      commitMessage: "Merge branch 'main' into feature/refactor",
      authorLogin: "octocat",
      parentCount: 2,
      botLogin: "grepiku-dev"
    }),
    null
  );

  assert.equal(
    headCommitReviewSkipReason({
      commitMessage: "chore: update follow-up branch",
      authorLogin: "grepiku-dev[bot]",
      parentCount: 1,
      botLogin: "grepiku-dev"
    }),
    "bot-commit"
  );

  assert.equal(
    headCommitReviewSkipReason({
      commitMessage: "chore: spoof bot-like author",
      authorLogin: "grepiku-helper[bot]",
      parentCount: 1,
      botLogin: "grepiku-dev"
    }),
    null
  );

  assert.equal(
    headCommitReviewSkipReason({
      commitMessage: "chore: unknown bot identity should not skip",
      authorLogin: "grepiku-dev[bot]",
      parentCount: 1,
      botLogin: ""
    }),
    null
  );
});

test("bootstrap repo indexing trusts the pull request base sha and fails closed without one", () => {
  assert.equal(
    selectBootstrapIndexSha({
      baseSha: "base123",
      headSha: "head456"
    }),
    "base123"
  );
  assert.equal(
    selectBootstrapIndexSha({
      baseSha: null,
      headSha: "head456"
    }),
    null
  );
});

test("post-review repo indexing stays pinned to the trusted pull request base sha", () => {
  assert.equal(
    selectTrustedPullRequestIndexSha({
      baseSha: "base123",
      headSha: "head456"
    }),
    "base123"
  );
  assert.equal(
    selectTrustedPullRequestIndexSha({
      baseSha: null,
      headSha: "head456"
    }),
    null
  );
});
