import "dotenv/config";
import { Worker } from "bullmq";
import { redisConnection, reviewQueue } from "../queue/index.js";
import { processReviewJob } from "../review/pipeline.js";
import { enqueueCommentReplyJob } from "../queue/enqueue.js";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection in review worker", reason);
});

const worker = new Worker(
  reviewQueue.name,
  async (job) => {
    if (job.name === "comment-reply") {
      console.warn(`Review queue received legacy comment-reply job ${job.id}; forwarding to mention queue`);
      await enqueueCommentReplyJob(job.data);
      return;
    }
    await processReviewJob(job.data);
  },
  {
    connection: redisConnection,
    concurrency: Number(process.env.REVIEW_WORKER_CONCURRENCY || 3)
  }
);

worker.on("failed", (job, err) => {
  console.error(`Review job ${job?.id} failed`, err);
});

worker.on("completed", (job) => {
  console.log(`Review job ${job.id} completed`);
});

console.log(`Review orchestrator started with log level ${env.logLevel}`);
