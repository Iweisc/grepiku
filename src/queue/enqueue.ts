import { reviewQueue, mentionQueue, indexQueue, graphQueue, analyticsQueue } from "./index.js";

export async function enqueueReviewJob(data: any) {
  await reviewQueue.add("review", data, {
    removeOnComplete: true,
    removeOnFail: false,
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
  await indexQueue.add("index", data, { removeOnComplete: true, removeOnFail: false });
}

export async function enqueueGraphJob(data: any) {
  await graphQueue.add("graph", data, { removeOnComplete: true, removeOnFail: false });
}

export async function enqueueAnalyticsJob(data: any) {
  await analyticsQueue.add("analytics", data, { removeOnComplete: true, removeOnFail: false });
}
