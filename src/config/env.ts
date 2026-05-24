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
  OPENAI_COMPAT_MODEL: z.string().default("gpt-5.3-codex"),
  EMBEDDINGS_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  OPENAI_EMBEDDINGS_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_EMBEDDINGS_DIMENSIONS: z.string().default(""),
  OPENAI_EMBEDDINGS_MAX_CHARS: z.string().default("12000"),
  OPENAI_EMBEDDINGS_BATCH_SIZE: z.string().default("16"),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_EMBEDDINGS_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta"),
  GEMINI_EMBEDDINGS_MODEL: z.string().default("gemini-embedding-2"),
  GEMINI_EMBEDDINGS_DIMENSIONS: z.string().default(""),
  GEMINI_EMBEDDINGS_DOCUMENT_TASK_TYPE: z.string().default("RETRIEVAL_DOCUMENT"),
  GEMINI_EMBEDDINGS_QUERY_TASK_TYPE: z.string().default("RETRIEVAL_QUERY"),
  OPENAI_TIMEOUT_MS: z.string().default("120000"),
  OPENAI_MAX_RETRIES: z.string().default("3"),
  CODEX_STAGE_TIMEOUT_MS: z.string().default("900000"),
  PROJECT_ROOT: z.string().min(1),
  CODEX_EXEC_PATH: z.string().default(""),
  CODEX_STAGE_LOG_OUTPUT: z.string().default("false"),
  CODEX_MODEL_REASONING_EFFORT: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
  INTERNAL_API_URL: z.string().default("http://web:3000/internal/retrieval"),
  SANDBOX_EXECUTION_MODE: z.enum(["local", "kubernetes"]).default("local"),
  K8S_NAMESPACE: z.string().default(""),
  K8S_SANDBOX_IMAGE: z.string().default(""),
  K8S_SANDBOX_SERVICE_ACCOUNT: z.string().default("default"),
  K8S_SANDBOX_IMAGE_PULL_SECRET: z.string().default(""),
  K8S_SANDBOX_CPU_REQUEST: z.string().default("500m"),
  K8S_SANDBOX_CPU_LIMIT: z.string().default("2"),
  K8S_SANDBOX_MEMORY_REQUEST: z.string().default("512Mi"),
  K8S_SANDBOX_MEMORY_LIMIT: z.string().default("2Gi"),
  K8S_SANDBOX_ACTIVE_DEADLINE_SECONDS: z.string().default("1200"),
  K8S_SANDBOX_POD_READY_TIMEOUT_MS: z.string().default("120000"),
  K8S_SANDBOX_TAR_MAX_BYTES: z.string().default("104857600"),
  K8S_SANDBOX_SYNC_MAX_BYTES: z.string().default("10485760"),
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
  embeddingsProvider: "openai" | "gemini";
  openaiEmbeddingsModel: string;
  openaiEmbeddingsDimensions: number | null;
  openaiEmbeddingsMaxChars: number;
  openaiEmbeddingsBatchSize: number;
  geminiApiKey: string;
  geminiEmbeddingsBaseUrl: string;
  geminiEmbeddingsModel: string;
  geminiEmbeddingsDimensions: number | null;
  geminiEmbeddingsDocumentTaskType: string;
  geminiEmbeddingsQueryTaskType: string;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
  codexStageTimeoutMs: number;
  projectRoot: string;
  codexExecPath: string;
  codexStageLogOutput: boolean;
  codexModelReasoningEffort: "low" | "medium" | "high" | "xhigh";
  internalApiUrl: string;
  sandboxExecutionMode: "local" | "kubernetes";
  k8sNamespace: string;
  k8sSandboxImage: string;
  k8sSandboxServiceAccount: string;
  k8sSandboxImagePullSecret: string;
  k8sSandboxCpuRequest: string;
  k8sSandboxCpuLimit: string;
  k8sSandboxMemoryRequest: string;
  k8sSandboxMemoryLimit: string;
  k8sSandboxActiveDeadlineSeconds: number;
  k8sSandboxPodReadyTimeoutMs: number;
  k8sSandboxTarMaxBytes: number;
  k8sSandboxSyncMaxBytes: number;
  logLevel: string;
};

let cached: Env | null = null;

function parseBooleanFlag(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

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
    embeddingsProvider: parsed.EMBEDDINGS_PROVIDER,
    openaiEmbeddingsModel: parsed.OPENAI_EMBEDDINGS_MODEL,
    openaiEmbeddingsDimensions: parsed.OPENAI_EMBEDDINGS_DIMENSIONS
      ? Number(parsed.OPENAI_EMBEDDINGS_DIMENSIONS)
      : null,
    openaiEmbeddingsMaxChars: embeddingsMaxChars,
    openaiEmbeddingsBatchSize: embeddingsBatchSize,
    geminiApiKey: parsed.GEMINI_API_KEY.trim(),
    geminiEmbeddingsBaseUrl: parsed.GEMINI_EMBEDDINGS_BASE_URL.trim(),
    geminiEmbeddingsModel: parsed.GEMINI_EMBEDDINGS_MODEL.trim(),
    geminiEmbeddingsDimensions: parsed.GEMINI_EMBEDDINGS_DIMENSIONS
      ? Number(parsed.GEMINI_EMBEDDINGS_DIMENSIONS)
      : null,
    geminiEmbeddingsDocumentTaskType: parsed.GEMINI_EMBEDDINGS_DOCUMENT_TASK_TYPE.trim(),
    geminiEmbeddingsQueryTaskType: parsed.GEMINI_EMBEDDINGS_QUERY_TASK_TYPE.trim(),
    openaiTimeoutMs: Number(parsed.OPENAI_TIMEOUT_MS),
    openaiMaxRetries: Number(parsed.OPENAI_MAX_RETRIES),
    codexStageTimeoutMs,
    projectRoot: parsed.PROJECT_ROOT,
    codexExecPath:
      codexExecPath.length > 0
        ? codexExecPath
        : path.join(parsed.PROJECT_ROOT, "internal_harness", "codex-slim", "target", "release", "codex-exec"),
    codexStageLogOutput: parseBooleanFlag(parsed.CODEX_STAGE_LOG_OUTPUT),
    codexModelReasoningEffort: parsed.CODEX_MODEL_REASONING_EFFORT,
    internalApiUrl: parsed.INTERNAL_API_URL.trim(),
    sandboxExecutionMode: parsed.SANDBOX_EXECUTION_MODE,
    k8sNamespace: parsed.K8S_NAMESPACE.trim(),
    k8sSandboxImage: parsed.K8S_SANDBOX_IMAGE.trim(),
    k8sSandboxServiceAccount: parsed.K8S_SANDBOX_SERVICE_ACCOUNT.trim() || "default",
    k8sSandboxImagePullSecret: parsed.K8S_SANDBOX_IMAGE_PULL_SECRET.trim(),
    k8sSandboxCpuRequest: parsed.K8S_SANDBOX_CPU_REQUEST.trim() || "500m",
    k8sSandboxCpuLimit: parsed.K8S_SANDBOX_CPU_LIMIT.trim() || "2",
    k8sSandboxMemoryRequest: parsed.K8S_SANDBOX_MEMORY_REQUEST.trim() || "512Mi",
    k8sSandboxMemoryLimit: parsed.K8S_SANDBOX_MEMORY_LIMIT.trim() || "2Gi",
    k8sSandboxActiveDeadlineSeconds: parsePositiveInteger(
      parsed.K8S_SANDBOX_ACTIVE_DEADLINE_SECONDS,
      1200
    ),
    k8sSandboxPodReadyTimeoutMs: parsePositiveInteger(
      parsed.K8S_SANDBOX_POD_READY_TIMEOUT_MS,
      120000
    ),
    k8sSandboxTarMaxBytes: parsePositiveInteger(parsed.K8S_SANDBOX_TAR_MAX_BYTES, 104857600),
    k8sSandboxSyncMaxBytes: parsePositiveInteger(parsed.K8S_SANDBOX_SYNC_MAX_BYTES, 10485760),
    logLevel: parsed.LOG_LEVEL
  };
  return cached;
}
