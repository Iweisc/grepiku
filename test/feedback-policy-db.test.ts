import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db/client.js";
import { getFeedbackPolicy } from "../src/services/feedback.js";
import { recalculateWeightsFromReactions } from "../src/services/weights.js";

test("getFeedbackPolicy scopes comment mapping to feedback-linked ids", async () => {
  const originalFeedbackFindMany = prisma.feedback.findMany;
  const originalReviewCommentFindMany = prisma.reviewComment.findMany;
  const originalFindingFindMany = prisma.finding.findMany;

  prisma.feedback.findMany = (async () => [
    {
      commentId: "provider-1",
      type: "reaction",
      sentiment: "thumbs_up",
      action: null,
      metadata: { authorAssociation: "MEMBER" }
    },
    {
      commentId: "provider-1",
      type: "reaction",
      sentiment: "thumbs_up",
      action: null,
      metadata: { authorAssociation: "MEMBER" }
    },
    {
      commentId: "provider-1",
      type: "reply",
      sentiment: null,
      action: "resolved",
      metadata: { authorAssociation: "MEMBER" }
    },
    {
      commentId: "finding-2",
      type: "reaction",
      sentiment: "thumbs_up",
      action: null,
      metadata: { authorAssociation: "MEMBER" }
    }
  ]) as typeof prisma.feedback.findMany;

  prisma.reviewComment.findMany = (async (args: any) => {
    assert.deepEqual(args.where.providerCommentId.in, ["provider-1", "finding-2"]);
    return [
      {
        providerCommentId: "provider-1",
        finding: {
          commentId: "finding-1",
          category: "security"
        }
      }
    ];
  }) as typeof prisma.reviewComment.findMany;

  prisma.finding.findMany = (async (args: any) => {
    assert.deepEqual(args.where.commentId.in, ["provider-1", "finding-2"]);
    return [
      {
        commentId: "finding-2",
        category: "security"
      }
    ];
  }) as typeof prisma.finding.findMany;

  try {
    const policy = await getFeedbackPolicy(7);
    assert.deepEqual(policy, {
      negativeCategories: [],
      positiveCategories: ["security"]
    });
  } finally {
    prisma.feedback.findMany = originalFeedbackFindMany;
    prisma.reviewComment.findMany = originalReviewCommentFindMany;
    prisma.finding.findMany = originalFindingFindMany;
  }
});

test("recalculateWeightsFromReactions scopes comment mapping to feedback-linked ids", async () => {
  const originalFeedbackFindMany = prisma.feedback.findMany;
  const originalReviewCommentFindMany = prisma.reviewComment.findMany;
  const originalFindingFindMany = prisma.finding.findMany;
  const originalFindingWeightFindUnique = prisma.findingWeight.findUnique;
  const originalFindingWeightUpsert = prisma.findingWeight.upsert;
  const upserts: Array<{ key: string; positive: number; negative: number }> = [];

  prisma.feedback.findMany = (async () => [
    {
      commentId: "provider-1",
      type: "reaction",
      sentiment: "thumbs_up",
      action: null,
      metadata: { authorAssociation: "MEMBER" }
    },
    {
      commentId: "finding-2",
      type: "reaction",
      sentiment: "thumbs_down",
      action: null,
      metadata: { authorAssociation: "MEMBER" }
    }
  ]) as typeof prisma.feedback.findMany;

  prisma.reviewComment.findMany = (async (args: any) => {
    assert.deepEqual(args.where.providerCommentId.in, ["provider-1", "finding-2"]);
    return [
      {
        providerCommentId: "provider-1",
        finding: {
          commentId: "finding-1",
          category: "security",
          ruleId: "rule-1"
        }
      }
    ];
  }) as typeof prisma.reviewComment.findMany;

  prisma.finding.findMany = (async (args: any) => {
    assert.deepEqual(args.where.commentId.in, ["provider-1", "finding-2"]);
    return [
      {
        commentId: "finding-2",
        category: "maintainability",
        ruleId: null
      }
    ];
  }) as typeof prisma.finding.findMany;

  prisma.findingWeight.findUnique = (async () => null) as typeof prisma.findingWeight.findUnique;
  prisma.findingWeight.upsert = (async (args: any) => {
    upserts.push({
      key: args.create.key,
      positive: args.create.positive,
      negative: args.create.negative
    });
    return args.create;
  }) as typeof prisma.findingWeight.upsert;

  try {
    await recalculateWeightsFromReactions(7);
    assert.deepEqual(upserts, [
      { key: "security", positive: 1, negative: 0 },
      { key: "security:rule-1", positive: 1, negative: 0 },
      { key: "maintainability", positive: 0, negative: 1 }
    ]);
  } finally {
    prisma.feedback.findMany = originalFeedbackFindMany;
    prisma.reviewComment.findMany = originalReviewCommentFindMany;
    prisma.finding.findMany = originalFindingFindMany;
    prisma.findingWeight.findUnique = originalFindingWeightFindUnique;
    prisma.findingWeight.upsert = originalFindingWeightUpsert;
  }
});
