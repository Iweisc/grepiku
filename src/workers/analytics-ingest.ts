import "dotenv/config";
import { Worker } from "bullmq";
import { analyticsQueue, redisConnection } from "../queue/index.js";
import { loadEnv } from "../config/env.js";
import { processAnalyticsJob } from "../services/analytics.js";

const env = loadEnv();

const worker = new Worker(
  analyticsQueue.name,
  async (job) => {
    await processAnalyticsJob(job.data);
  },
  { connection: redisConnection, concurrency: Number(process.env.ANALYTICS_CONCURRENCY || 2) }
);

worker.on("failed", (job, err) => {
  console.error(`Analytics job ${job?.id} failed`, err);
});

worker.on("completed", (job) => {
  console.log(`Analytics job ${job.id} completed`);
});

console.log(`Analytics ingest started with log level ${env.logLevel}`);
