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

test("mention verification is skipped for fork pull requests", async () => {
  const { planMentionChecks } = await loadMentionInternals();

  assert.deepEqual(
    planMentionChecks({
      repoFullName: "acme/widgets",
      pullRequest: {
        headRepoFullName: "contrib/widgets-fork",
        headSha: "abc123"
      }
    }),
    {
      shouldRun: false,
      skippedSummary: "skipped for untrusted fork pull request"
    }
  );
});

test("mention verification still runs for same-repo pull requests", async () => {
  const { planMentionChecks } = await loadMentionInternals();

  assert.deepEqual(
    planMentionChecks({
      repoFullName: "acme/widgets",
      pullRequest: {
        headRepoFullName: "acme/widgets",
        headSha: "abc123"
      }
    }),
    {
      shouldRun: true,
      skippedSummary: null
    }
  );
});

test("mention implementation is blocked for fork pull requests", async () => {
  const { planMentionImplementation } = await loadMentionInternals();

  assert.deepEqual(
    planMentionImplementation({
      repoFullName: "acme/widgets",
      pullRequest: {
        headRepoFullName: "contrib/widgets-fork",
        headSha: "abc123"
      }
    }),
    {
      shouldRun: false,
      deniedSummary: "blocked for untrusted fork pull request"
    }
  );
});

test("mention implementation still runs for same-repo pull requests", async () => {
  const { planMentionImplementation } = await loadMentionInternals();

  assert.deepEqual(
    planMentionImplementation({
      repoFullName: "acme/widgets",
      pullRequest: {
        headRepoFullName: "acme/widgets",
        headSha: "abc123"
      }
    }),
    {
      shouldRun: true,
      deniedSummary: null
    }
  );
});

test("trusted-config mention tasks are still blocked for untrusted fork pull requests", async () => {
  const { resolveMentionExecutionMode } = await loadMentionInternals();

  assert.equal(
    resolveMentionExecutionMode({
      mentionTask: "apply the requested fix",
      commentAuthorAssociation: "COLLABORATOR",
      repoFullName: "acme/widgets",
      pullRequest: {
        headRepoFullName: "contrib/widgets-fork",
        headSha: "abc123"
      }
    }),
    "deny_untrusted_fork"
  );
});
