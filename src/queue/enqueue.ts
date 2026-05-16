import { reviewQueue, mentionQueue, indexQueue, graphQueue, analyticsQueue } from "./index.js";
import {
  buildAnalyticsJobId,
  buildCommentReplyJobId,
  buildGraphJobId,
  buildIndexJobId,
  buildReviewJobId
} from "./jobId.js";

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
  const jobId = buildCommentReplyJobId(data);
  await mentionQueue.add("comment-reply", data, {
    jobId,
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
  const jobId = buildGraphJobId(data);
  await graphQueue.add("graph", data, {
    jobId,
    removeOnComplete: true,
    removeOnFail: false
  });
}

export async function enqueueAnalyticsJob(data: any) {
  const jobId = buildAnalyticsJobId(data);
  await analyticsQueue.add("analytics", data, {
    jobId,
    removeOnComplete: true,
    removeOnFail: false
  });
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
