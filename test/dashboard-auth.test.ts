import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

function dashboardAuthKey(): string {
  if (!process.env.INTERNAL_API_KEY) process.env.INTERNAL_API_KEY = "dashboard-test-key";
  return process.env.INTERNAL_API_KEY;
}

function ensureDashboardTestEnv(): void {
  const required: Record<string, string> = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/grepiku_test",
    REDIS_URL: "redis://localhost:6379",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "test-key",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENAI_COMPAT_BASE_URL: "https://example.test/v1",
    OPENAI_COMPAT_API_KEY: "test-openai-key",
    PROJECT_ROOT: process.cwd(),
    INTERNAL_API_KEY: dashboardAuthKey()
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

async function loadDashboardModule() {
  ensureDashboardTestEnv();
  return import("../src/server/dashboard.js");
}

test("authorize accepts HTTP Basic auth password as internal key", async () => {
  const { authorize } = await loadDashboardInternals();
  const auth = Buffer.from(`any-user:${dashboardAuthKey()}`, "utf8").toString("base64");
  assert.equal(
    authorize({
      headers: {
        authorization: `Basic ${auth}`
      }
    }),
    true
  );
});

test("authorize rejects invalid dashboard auth token", async () => {
  const { authorize } = await loadDashboardInternals();
  assert.equal(
    authorize({
      headers: {
        authorization: "Bearer not-the-right-key"
      }
    }),
    false
  );
});

test("dashboard route requires authentication", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const unauthorized = await app.inject({ method: "GET", url: "/dashboard" });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(
    unauthorized.headers["www-authenticate"],
    'Basic realm="Grepiku Dashboard"'
  );

  const authorized = await app.inject({
    method: "GET",
    url: "/dashboard",
    headers: { "x-internal-key": dashboardAuthKey() }
  });
  assert.equal(authorized.statusCode, 200);
});

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
