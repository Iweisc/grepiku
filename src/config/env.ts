import { z } from "zod";
import path from "path";

const EnvSchema = z.object({
  PORT: z.string().default("3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_BOT_LOGIN: z.string().default(""),
  INTERNAL_API_KEY: z.string().default(""),
  OPENAI_COMPAT_BASE_URL: z.string().min(1),
  OPENAI_COMPAT_API_KEY: z.string().min(1),
  OPENAI_COMPAT_MODEL: z.string().default("gpt-5.2-codex-xhigh"),
  OPENAI_EMBEDDINGS_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_EMBEDDINGS_DIMENSIONS: z.string().default(""),
  OPENAI_EMBEDDINGS_MAX_CHARS: z.string().default("12000"),
  OPENAI_EMBEDDINGS_BATCH_SIZE: z.string().default("16"),
  OPENAI_TIMEOUT_MS: z.string().default("120000"),
  OPENAI_MAX_RETRIES: z.string().default("3"),
  CODEX_STAGE_TIMEOUT_MS: z.string().default("900000"),
  PROJECT_ROOT: z.string().min(1),
  CODEX_EXEC_PATH: z.string().default(""),
  INTERNAL_API_URL: z.string().default("http://web:3000/internal/retrieval"),
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
  internalApiKey: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiEmbeddingsModel: string;
  openaiEmbeddingsDimensions: number | null;
  openaiEmbeddingsMaxChars: number;
  openaiEmbeddingsBatchSize: number;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
  codexStageTimeoutMs: number;
  projectRoot: string;
  codexExecPath: string;
  internalApiUrl: string;
  logLevel: string;
};

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.parse(process.env);
  const privateKey = parsed.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n");
  const embeddingsBatchRaw = Number(parsed.OPENAI_EMBEDDINGS_BATCH_SIZE);
  const embeddingsBatchSize =
    Number.isFinite(embeddingsBatchRaw) && embeddingsBatchRaw > 0
      ? Math.floor(embeddingsBatchRaw)
      : 16;
  const embeddingsMaxCharsRaw = Number(parsed.OPENAI_EMBEDDINGS_MAX_CHARS);
  const embeddingsMaxChars =
    Number.isFinite(embeddingsMaxCharsRaw) && embeddingsMaxCharsRaw > 0
      ? Math.floor(embeddingsMaxCharsRaw)
      : 12000;
  const codexStageTimeoutRaw = Number(parsed.CODEX_STAGE_TIMEOUT_MS);
  const codexStageTimeoutMs =
    Number.isFinite(codexStageTimeoutRaw) && codexStageTimeoutRaw > 0
      ? Math.floor(codexStageTimeoutRaw)
      : 900000;
  const codexExecPath = parsed.CODEX_EXEC_PATH.trim();
  cached = {
    port: Number(parsed.PORT),
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    githubAppId: Number(parsed.GITHUB_APP_ID),
    githubPrivateKey: privateKey,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    githubBotLogin: parsed.GITHUB_BOT_LOGIN.trim(),
    internalApiKey: parsed.INTERNAL_API_KEY.trim(),
    openaiBaseUrl: parsed.OPENAI_COMPAT_BASE_URL,
    openaiApiKey: parsed.OPENAI_COMPAT_API_KEY,
    openaiModel: parsed.OPENAI_COMPAT_MODEL,
    openaiEmbeddingsModel: parsed.OPENAI_EMBEDDINGS_MODEL,
    openaiEmbeddingsDimensions: parsed.OPENAI_EMBEDDINGS_DIMENSIONS
      ? Number(parsed.OPENAI_EMBEDDINGS_DIMENSIONS)
      : null,
    openaiEmbeddingsMaxChars: embeddingsMaxChars,
    openaiEmbeddingsBatchSize: embeddingsBatchSize,
    openaiTimeoutMs: Number(parsed.OPENAI_TIMEOUT_MS),
    openaiMaxRetries: Number(parsed.OPENAI_MAX_RETRIES),
    codexStageTimeoutMs,
    projectRoot: parsed.PROJECT_ROOT,
    codexExecPath:
      codexExecPath.length > 0
        ? codexExecPath
        : path.join(parsed.PROJECT_ROOT, "internal_harness", "codex-slim", "target", "release", "codex-exec"),
    internalApiUrl: parsed.INTERNAL_API_URL.trim(),
    logLevel: parsed.LOG_LEVEL
  };
  return cached;
}
