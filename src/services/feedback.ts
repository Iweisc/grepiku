import { prisma } from "../db/client.js";

const POSITIVE_REACTIONS = new Set(["thumbs_up", "+1", "heart", "laugh", "hooray"]);
const NEGATIVE_REACTIONS = new Set(["thumbs_down", "-1", "confused"]);

export type FeedbackPolicy = {
  negativeCategories: string[];
  positiveCategories: string[];
};

export async function getFeedbackPolicy(repoId: number): Promise<FeedbackPolicy> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const feedback = await prisma.feedback.findMany({
    where: { createdAt: { gte: since }, reviewRun: { pullRequest: { repoId } } },
    orderBy: { createdAt: "desc" },
    take: 500
  });
  if (feedback.length === 0) {
    return { negativeCategories: [], positiveCategories: [] };
  }

  const reviewComments = await prisma.reviewComment.findMany({
    where: { createdAt: { gte: since }, pullRequest: { repoId } },
    include: { finding: true }
  });

  const providerToFinding = new Map<string, string>();
  const categoryByComment = new Map<string, string>();
  for (const comment of reviewComments) {
    const finding = comment.finding;
    if (!finding) continue;
    categoryByComment.set(finding.commentId, finding.category);
    providerToFinding.set(comment.providerCommentId, finding.commentId);
  }

  const counts = new Map<string, { pos: number; neg: number }>();
  for (const fb of feedback) {
    if (!fb.commentId) continue;
    const commentId = providerToFinding.get(fb.commentId) || fb.commentId;
    const category = categoryByComment.get(commentId);
    if (!category) continue;
    const entry = counts.get(category) || { pos: 0, neg: 0 };
    if (fb.type === "reaction" && fb.sentiment) {
      if (POSITIVE_REACTIONS.has(fb.sentiment)) entry.pos += 1;
      if (NEGATIVE_REACTIONS.has(fb.sentiment)) entry.neg += 1;
    }
    if (fb.type === "reply" && fb.action === "resolved") entry.pos += 1;
    counts.set(category, entry);
  }

  const negativeCategories: string[] = [];
  const positiveCategories: string[] = [];
  for (const [category, entry] of counts.entries()) {
    if (entry.neg >= 3 && entry.neg >= entry.pos * 1.5) {
      negativeCategories.push(category);
    }
    if (entry.pos >= 3 && entry.pos >= entry.neg * 1.5) {
      positiveCategories.push(category);
    }
  }

  return { negativeCategories, positiveCategories };
}
