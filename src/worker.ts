import "dotenv/config";
import { Worker } from "bullmq";
import { redisConnection } from "./queue/index.js";
import { processReviewJob } from "./review/pipeline.js";
import { processCommentReplyJob } from "./review/mentions.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();

const worker = new Worker(
  "pr-review",
  async (job) => {
    if (job.name === "comment-reply") {
      await processCommentReplyJob(job.data);
      return;
    }
    await processReviewJob(job.data);
  },
  {
    connection: redisConnection
  }
);

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed`, err);
});

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

console.log(`Worker started with log level ${env.logLevel}`);
