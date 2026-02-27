import test from "node:test";
import assert from "node:assert/strict";

function ensureMentionTestEnv(): void {
  const required: Record<string, string> = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/grepiku_test",
    REDIS_URL: "redis://localhost:6379",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "test-key",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENAI_COMPAT_BASE_URL: "https://example.test/v1",
    OPENAI_COMPAT_API_KEY: "test-openai-key",
    PROJECT_ROOT: process.cwd()
  };
  for (const [key, value] of Object.entries(required)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

async function loadMentionInternals() {
  ensureMentionTestEnv();
  const module = await import("../src/review/mentions.js");
  return module.__mentionInternals;
}

test("postMentionReply falls back to summary comment when thread reply fails", async () => {
  const { postMentionReply } = await loadMentionInternals();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const summaries: string[] = [];
  let replyAttempts = 0;
  try {
    await postMentionReply({
      client: {
        createSummaryComment: async (body: string) => {
          summaries.push(body);
        },
        replyToComment: async () => {
          replyAttempts += 1;
          throw new Error("api failed");
        }
      },
      commentId: "101",
      body: "hello",
      replyInThread: true
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(replyAttempts, 1);
  assert.equal(summaries.length, 1);
  assert.match(String(warnings[0]?.[0] || ""), /falling back to summary comment/);
});

test("postMentionReply falls back to summary comment when replyToComment is unavailable", async () => {
  const { postMentionReply } = await loadMentionInternals();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const summaries: string[] = [];
  try {
    await postMentionReply({
      client: {
        createSummaryComment: async (body: string) => {
          summaries.push(body);
        }
      },
      commentId: "102",
      body: "hello",
      replyInThread: true
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(summaries.length, 1);
  assert.match(String(warnings[0]?.[0] || ""), /provider does not support replyToComment; falling back/);
});
