import crypto from "crypto";
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
  const repoId = String(data?.repoId ?? "unknown");
  const patternRepo = data?.patternRepo as { url?: string; ref?: string; name?: string } | undefined;
  const scopeRaw = patternRepo
    ? `pattern:${patternRepo.url || patternRepo.name || "unknown"}:${patternRepo.ref || "HEAD"}`
    : "repo";
  const scope = crypto.createHash("sha1").update(scopeRaw).digest("hex").slice(0, 12);
  const headSha = String(data?.headSha || "HEAD");
  const force = data?.force ? "force" : "normal";
  const jobId = `index:${repoId}:${scope}:${headSha}:${force}`;
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
