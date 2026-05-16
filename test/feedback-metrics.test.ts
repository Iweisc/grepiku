import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeTrackedTrustedFeedback,
  summarizeTrustedFeedback,
  formatAcceptanceRate
} from "../src/services/feedbackMetrics.js";
import { prisma } from "../src/db/client.js";

test("summarizeTrustedFeedback ignores untrusted reactions and replies", () => {
  const summary = summarizeTrustedFeedback([
    {
      type: "reaction",
      sentiment: "thumbs_up",
      metadata: { authorAssociation: "MEMBER" }
    },
    {
      type: "reaction",
      sentiment: "thumbs_down",
      metadata: { authorAssociation: "CONTRIBUTOR" }
    },
    {
      type: "reply",
      action: "resolved",
      metadata: { author_association: "COLLABORATOR" }
    },
    {
      type: "reply",
      action: "resolved",
      metadata: { authorAssociation: "NONE" }
    }
  ]);

  assert.deepEqual(summary, {
    positive: 2,
    negative: 0,
    totalTrusted: 2,
    acceptanceRate: 100
  });
});

test("summarizeTrustedFeedback returns null acceptance when trusted feedback is absent", () => {
  const summary = summarizeTrustedFeedback([
    {
      type: "reaction",
      sentiment: "thumbs_up",
      metadata: { authorAssociation: "CONTRIBUTOR" }
    }
  ]);

  assert.deepEqual(summary, {
    positive: 0,
    negative: 0,
    totalTrusted: 0,
    acceptanceRate: null
  });
});

test("summarizeTrackedTrustedFeedback ignores trusted feedback on unrelated PR comments", async () => {
  const originalReviewCommentFindMany = prisma.reviewComment.findMany;
  const originalFindingFindMany = prisma.finding.findMany;

  prisma.reviewComment.findMany = (async (args?: unknown) => {
    assert.deepEqual((args as { where?: { providerCommentId?: { in?: string[] } } })?.where?.providerCommentId?.in, [
      "bot-summary-1",
      "human-discussion-1",
      "finding-comment-1"
    ]);
    return [{ providerCommentId: "bot-summary-1" }];
  }) as typeof prisma.reviewComment.findMany;

  prisma.finding.findMany = (async (args?: unknown) => {
    assert.deepEqual((args as { where?: { commentId?: { in?: string[] } } })?.where?.commentId?.in, [
      "bot-summary-1",
      "human-discussion-1",
      "finding-comment-1"
    ]);
    return [{ commentId: "finding-comment-1" }];
  }) as typeof prisma.finding.findMany;

  try {
    const summary = await summarizeTrackedTrustedFeedback(
      [
        {
          type: "reaction",
          sentiment: "thumbs_up",
          commentId: "bot-summary-1",
          metadata: { authorAssociation: "MEMBER" }
        },
        {
          type: "reaction",
          sentiment: "thumbs_down",
          commentId: "human-discussion-1",
          metadata: { authorAssociation: "COLLABORATOR" }
        },
        {
          type: "reply",
          action: "resolved",
          commentId: "finding-comment-1",
          metadata: { authorAssociation: "OWNER" }
        }
      ],
      { repoId: 7 }
    );

    assert.deepEqual(summary, {
      positive: 2,
      negative: 0,
      totalTrusted: 2,
      acceptanceRate: 100
    });
  } finally {
    prisma.reviewComment.findMany = originalReviewCommentFindMany;
    prisma.finding.findMany = originalFindingFindMany;
  }
});

test("formatAcceptanceRate preserves null values for reporting", () => {
  assert.equal(formatAcceptanceRate(null), "N/A");
  assert.equal(formatAcceptanceRate(67), "67%");
});
