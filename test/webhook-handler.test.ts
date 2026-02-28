import test from "node:test";
import assert from "node:assert/strict";
import { isGeneratedMentionReply, isSelfBotComment, normalizeBotAwareLogin } from "../src/providers/commentGuards.js";
import { isResolutionReply } from "../src/providers/commentResolution.js";
import { shouldDeleteClosedBotPrBranch, shouldSkipSelfBotFollowUpPrReview } from "../src/providers/pullRequestGuards.js";

test("normalizeBotAwareLogin strips [bot] suffix", () => {
  assert.equal(normalizeBotAwareLogin("grepiku-dev[bot]"), "grepiku-dev");
  assert.equal(normalizeBotAwareLogin("grepiku-dev"), "grepiku-dev");
});

test("isSelfBotComment matches bot login with or without [bot] suffix", () => {
  assert.equal(
    isSelfBotComment({
      authorLogin: "grepiku-dev[bot]",
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
