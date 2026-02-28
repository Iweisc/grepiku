import "dotenv/config";
import { Worker } from "bullmq";
import { mentionQueue, redisConnection } from "../queue/index.js";
import { processCommentReplyJob } from "../review/mentions.js";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

const worker = new Worker(
  mentionQueue.name,
  async (job) => {
    await processCommentReplyJob(job.data);
  },
  {
    connection: redisConnection,
    concurrency: Number(process.env.MENTION_WORKER_CONCURRENCY || 3)
  }
);

worker.on("failed", (job, err) => {
  console.error(`Mention reply job ${job?.id} failed`, err);
});

worker.on("completed", (job) => {
  console.log(`Mention reply job ${job.id} completed`);
});

console.log(`Mention replies worker started with log level ${env.logLevel}`);
