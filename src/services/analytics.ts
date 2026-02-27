import { prisma } from "../db/client.js";
import { computeTraversalRunMetrics } from "./traversalMetrics.js";

type AnalyticsJob = {
  reviewRunId: number;
};

export async function processAnalyticsJob(job: AnalyticsJob) {
  const run = await prisma.reviewRun.findFirst({
    where: { id: job.reviewRunId },
    include: { findings: true, pullRequest: true, feedback: true }
  });
  if (!run) return;

  await prisma.analyticsEvent.deleteMany({
    where: {
      runId: run.id,
      kind: { in: ["review_run", "traversal_run"] }
    }
  });

  const durationMs =
    run.startedAt && run.completedAt ? run.completedAt.getTime() - run.startedAt.getTime() : null;
  const counts = run.findings.reduce(
    (acc, finding) => {
      acc.total += 1;
      acc.bySeverity[finding.severity] = (acc.bySeverity[finding.severity] || 0) + 1;
      acc.byCategory[finding.category] = (acc.byCategory[finding.category] || 0) + 1;
      return acc;
    },
    { total: 0, bySeverity: {} as Record<string, number>, byCategory: {} as Record<string, number> }
  );

  await prisma.analyticsEvent.create({
    data: {
      repoId: run.pullRequest.repoId,
      runId: run.id,
      kind: "review_run",
      payload: {
        durationMs,
        counts,
        status: run.status,
        trigger: run.trigger
      }
    }
  });

  const repoFileCount = await prisma.fileIndex.count({
    where: { repoId: run.pullRequest.repoId, isPattern: false }
  });
  const traversalMetrics = computeTraversalRunMetrics({
    runId: run.id,
    repoId: run.pullRequest.repoId,
    contextPack: run.contextPackJson,
    findings: run.findings.map((finding) => ({ path: finding.path, status: finding.status })),
    repoFileCount
  });
  if (traversalMetrics) {
    await prisma.analyticsEvent.create({
      data: {
        repoId: run.pullRequest.repoId,
        runId: run.id,
        kind: "traversal_run",
        payload: traversalMetrics
      }
    });
  }

  const positiveReactions = new Set(["thumbs_up", "+1", "heart", "laugh", "hooray"]);
  const negativeReactions = new Set(["thumbs_down", "-1", "confused"]);

  const feedbackByFinding = new Map<string, { pos: number; neg: number }>();
  for (const feedback of run.feedback) {
    if (!feedback.commentId) continue;
    const entry = feedbackByFinding.get(feedback.commentId) || { pos: 0, neg: 0 };
    if (feedback.type === "reaction" && feedback.sentiment) {
      if (positiveReactions.has(feedback.sentiment)) entry.pos += 1;
      if (negativeReactions.has(feedback.sentiment)) entry.neg += 1;
    }
    if (feedback.type === "reply" && feedback.action === "resolved") entry.pos += 1;
    feedbackByFinding.set(feedback.commentId, entry);
  }

  const suggestionBuckets = new Map<string, { count: number; sample: any }>();
  for (const finding of run.findings) {
    if (finding.ruleId) continue;
    const feedback = feedbackByFinding.get(finding.commentId);
    if (!feedback || feedback.pos <= feedback.neg) continue;
    const key = `${finding.category}:${finding.title}`;
    const bucket = suggestionBuckets.get(key) || { count: 0, sample: finding };
    bucket.count += 1;
    suggestionBuckets.set(key, bucket);
  }

  for (const [key, bucket] of suggestionBuckets.entries()) {
    if (bucket.count < 2) continue;
    const reason = `High positive feedback (${bucket.count}) for repeated finding: ${bucket.sample.title}`;
    const existing = await prisma.ruleSuggestion.findFirst({
      where: { repoId: run.pullRequest.repoId, reason }
    });
    if (existing) continue;
    await prisma.ruleSuggestion.create({
      data: {
        repoId: run.pullRequest.repoId,
        ruleJson: {
          id: `suggested-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
          title: bucket.sample.title,
          category: bucket.sample.category,
          severity: bucket.sample.severity,
          pattern: "",
          scope: "",
          commentType: "inline"
        },
        reason
      }
    });
  }
}
