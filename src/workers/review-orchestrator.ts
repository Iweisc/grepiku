import "dotenv/config";
import { Worker } from "bullmq";
import { redisConnection, reviewQueue } from "../queue/index.js";
import { processReviewJob } from "../review/pipeline.js";
import { processCommentReplyJob } from "../review/mentions.js";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

const worker = new Worker(
  reviewQueue.name,
  async (job) => {
    if (job.name === "comment-reply") {
      await processCommentReplyJob(job.data);
      return;
    }
    await processReviewJob(job.data);
  },
  {
    connection: redisConnection,
    concurrency: Number(process.env.REVIEW_WORKER_CONCURRENCY || 1)
  }
);

worker.on("failed", (job, err) => {
  console.error(`Review job ${job?.id} failed`, err);
});

worker.on("completed", (job) => {
  console.log(`Review job ${job.id} completed`);
});

console.log(`Review orchestrator started with log level ${env.logLevel}`);
