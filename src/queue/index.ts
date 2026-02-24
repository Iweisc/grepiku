import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

export const redisConnection = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null
});

export const reviewQueue = new Queue("pr-review", {
  connection: redisConnection
});
