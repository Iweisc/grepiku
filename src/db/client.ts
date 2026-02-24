import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

export const prisma = new PrismaClient({
  datasources: { db: { url: env.databaseUrl } }
});
