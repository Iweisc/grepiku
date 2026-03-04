import { reviewQueue, mentionQueue, indexQueue, graphQueue, analyticsQueue } from "./index.js";
import { buildIndexJobId, buildReviewJobId } from "./jobId.js";

export async function enqueueReviewJob(data: any) {
  const forceRun = Boolean(data?.force);
  const jobId = forceRun ? undefined : buildReviewJobId(data);
  await reviewQueue.add("review", data, {
    jobId,
    removeOnComplete: true,
    removeOnFail: forceRun ? false : true,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 }
  });
}

export async function enqueueCommentReplyJob(data: any) {
  await mentionQueue.add("comment-reply", data, {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 2,
    backoff: { type: "exponential", delay: 3000 }
  });
}

export async function enqueueIndexJob(data: any) {
  const jobId = buildIndexJobId(data);
  await indexQueue.add("index", data, {
    jobId,
    removeOnComplete: true,
    removeOnFail: false
  });
}

export async function enqueueGraphJob(data: any) {
  await graphQueue.add("graph", data, { removeOnComplete: true, removeOnFail: false });
}

export async function enqueueAnalyticsJob(data: any) {
  await analyticsQueue.add("analytics", data, { removeOnComplete: true, removeOnFail: false });
}

export async function cancelReviewJobsForPr(pullRequestId: number): Promise<number> {
  const waiting = await reviewQueue.getJobs(["waiting", "delayed", "prioritized"]);
  let cancelled = 0;
  for (const job of waiting) {
    if (job.data?.pullRequestId === pullRequestId && job.name === "review") {
      try {
        await job.remove();
        cancelled++;
      } catch {
        // Job may have started processing between getJobs and remove; ignore.
      }
    }
  }
  return cancelled;
}
