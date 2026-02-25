import "dotenv/config";
import { Worker } from "bullmq";
import { graphQueue, redisConnection } from "../queue/index.js";
import { loadEnv } from "../config/env.js";
import { processGraphJob } from "../services/graph.js";

const env = loadEnv();

const worker = new Worker(
  graphQueue.name,
  async (job) => {
    await processGraphJob(job.data);
  },
  { connection: redisConnection, concurrency: Number(process.env.GRAPH_CONCURRENCY || 2) }
);

worker.on("failed", (job, err) => {
  console.error(`Graph job ${job?.id} failed`, err);
});

worker.on("completed", (job) => {
  console.log(`Graph job ${job.id} completed`);
});

console.log(`Graph builder started with log level ${env.logLevel}`);
