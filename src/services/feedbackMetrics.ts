import { prisma } from "../db/client.js";
import { isTrustedFeedbackMetadata } from "./feedbackTrust.js";

const POSITIVE_REACTIONS = new Set(["thumbs_up", "+1", "heart", "laugh", "hooray"]);
const NEGATIVE_REACTIONS = new Set(["thumbs_down", "-1", "confused"]);

type FeedbackLike = {
  type?: string | null;
  sentiment?: string | null;
  action?: string | null;
  commentId?: string | null;
  metadata?: unknown;
};

export type TrustedFeedbackSummary = {
  positive: number;
  negative: number;
  totalTrusted: number;
  acceptanceRate: number | null;
};

export function summarizeTrustedFeedback(
  feedback: Iterable<FeedbackLike>
): TrustedFeedbackSummary {
  let positive = 0;
  let negative = 0;
  let totalTrusted = 0;

  for (const item of feedback) {
    if (!isTrustedFeedbackMetadata(item.metadata)) {
      continue;
    }
    totalTrusted += 1;
    if (item.type === "reaction" && item.sentiment) {
      if (POSITIVE_REACTIONS.has(item.sentiment)) {
        positive += 1;
      }
      if (NEGATIVE_REACTIONS.has(item.sentiment)) {
        negative += 1;
      }
    }
    if (item.type === "reply" && item.action === "resolved") {
      positive += 1;
    }
  }

  const acceptanceRate =
    positive + negative > 0 ? Math.round((positive / (positive + negative)) * 100) : null;

  return {
    positive,
    negative,
    totalTrusted,
    acceptanceRate
  };
}

export async function summarizeTrackedTrustedFeedback(
  feedback: Iterable<FeedbackLike>,
  options?: { repoId?: number }
): Promise<TrustedFeedbackSummary> {
  const trustedItems = Array.from(feedback).flatMap((item) => {
    const commentId = typeof item.commentId === "string" ? item.commentId.trim() : "";
    if (!isTrustedFeedbackMetadata(item.metadata) || !commentId) {
      return [];
    }
    return [{ ...item, commentId }];
  });

  if (trustedItems.length === 0) {
    return {
      positive: 0,
      negative: 0,
      totalTrusted: 0,
      acceptanceRate: null
    };
  }

  const commentIds = Array.from(new Set(trustedItems.map((item) => item.commentId)));
  const repoFilter = options?.repoId ? { pullRequest: { repoId: options.repoId } } : {};
  const [reviewComments, findings] = await Promise.all([
    prisma.reviewComment.findMany({
      where: {
        providerCommentId: { in: commentIds },
        ...repoFilter
      },
      select: { providerCommentId: true }
    }),
    prisma.finding.findMany({
      where: {
        commentId: { in: commentIds },
        ...repoFilter
      },
      select: { commentId: true }
    })
  ]);

  const trackedCommentIds = new Set<string>([
    ...reviewComments.map((comment) => comment.providerCommentId),
    ...findings.map((finding) => finding.commentId)
  ]);

  return summarizeTrustedFeedback(
    trustedItems.filter((item) => trackedCommentIds.has(item.commentId))
  );
}

export function formatAcceptanceRate(value: number | null): string {
  return value === null ? "N/A" : `${value}%`;
}
