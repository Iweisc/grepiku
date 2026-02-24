import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

export const redisConnection = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null
});

export const reviewQueue = new Queue("review-orchestrator", {
  connection: redisConnection
});

export const indexQueue = new Queue("indexer", {
  connection: redisConnection
});

export const graphQueue = new Queue("graph-builder", {
  connection: redisConnection
});

export const analyticsQueue = new Queue("analytics-ingest", {
  connection: redisConnection
});
