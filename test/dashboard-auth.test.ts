import test from "node:test";
import assert from "node:assert/strict";

function ensureDashboardTestEnv(): void {
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

async function loadDashboardInternals() {
  ensureDashboardTestEnv();
  const module = await import("../src/server/dashboard.js");
  return module.__dashboardInternals;
}

test("isSameOriginRequest allows same-origin requests via Origin header", async () => {
  const { isSameOriginRequest } = await loadDashboardInternals();
  assert.equal(
    isSameOriginRequest({
      protocol: "http",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000"
      }
    }),
    true
  );
});

test("isSameOriginRequest rejects cross-origin requests", async () => {
  const { isSameOriginRequest } = await loadDashboardInternals();
  assert.equal(
    isSameOriginRequest({
      protocol: "http",
      headers: {
        host: "localhost:3000",
        origin: "http://evil.test"
      }
    }),
    false
  );
});

test("isSameOriginRequest handles forwarded host/proto", async () => {
  const { isSameOriginRequest } = await loadDashboardInternals();
  assert.equal(
    isSameOriginRequest({
      protocol: "http",
      headers: {
        host: "127.0.0.1:3000",
        origin: "https://review.example.com",
        "x-forwarded-host": "review.example.com",
        "x-forwarded-proto": "https"
      }
    }),
    true
  );
});
