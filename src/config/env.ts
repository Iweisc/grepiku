import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.string().default("3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_BOT_LOGIN: z.string().default(""),
  OPENAI_COMPAT_BASE_URL: z.string().min(1),
  OPENAI_COMPAT_API_KEY: z.string().min(1),
  OPENAI_COMPAT_MODEL: z.string().default("gpt-5.2-codex-xhigh"),
  OPENAI_TIMEOUT_MS: z.string().default("120000"),
  OPENAI_MAX_RETRIES: z.string().default("3"),
  PROJECT_ROOT: z.string().min(1),
  RUNNER_IMAGE: z.string().default("grepiku-codex-runner"),
  RUNNER_NETWORK: z.string().default("auto"),
  RUNNER_AUTOBUILD: z.string().default("true"),
  LOG_LEVEL: z.string().default("info")
});

export type Env = {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  githubAppId: number;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  githubBotLogin: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
  projectRoot: string;
  runnerImage: string;
  runnerNetwork: string;
  runnerAutobuild: boolean;
  logLevel: string;
};

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.parse(process.env);
  const privateKey = parsed.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n");
  cached = {
    port: Number(parsed.PORT),
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    githubAppId: Number(parsed.GITHUB_APP_ID),
    githubPrivateKey: privateKey,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    githubBotLogin: parsed.GITHUB_BOT_LOGIN.trim(),
    openaiBaseUrl: parsed.OPENAI_COMPAT_BASE_URL,
    openaiApiKey: parsed.OPENAI_COMPAT_API_KEY,
    openaiModel: parsed.OPENAI_COMPAT_MODEL,
    openaiTimeoutMs: Number(parsed.OPENAI_TIMEOUT_MS),
    openaiMaxRetries: Number(parsed.OPENAI_MAX_RETRIES),
    projectRoot: parsed.PROJECT_ROOT,
    runnerImage: parsed.RUNNER_IMAGE,
    runnerNetwork: parsed.RUNNER_NETWORK,
    runnerAutobuild: parsed.RUNNER_AUTOBUILD !== "false" && parsed.RUNNER_AUTOBUILD !== "0",
    logLevel: parsed.LOG_LEVEL
  };
  return cached;
}
