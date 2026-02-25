import "dotenv/config";
import { Worker } from "bullmq";
import { indexQueue, redisConnection } from "../queue/index.js";
import { loadEnv } from "../config/env.js";
import { processIndexJob } from "../services/indexer.js";

const env = loadEnv();

const worker = new Worker(
  indexQueue.name,
  async (job) => {
    await processIndexJob(job.data);
  },
  { connection: redisConnection, concurrency: Number(process.env.INDEXER_CONCURRENCY || 4) }
);

worker.on("failed", (job, err) => {
  console.error(`Index job ${job?.id} failed`, err);
});

worker.on("completed", (job) => {
  console.log(`Index job ${job.id} completed`);
});

console.log(`Indexer started with log level ${env.logLevel}`);
