import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { prisma } from "../src/db/client.js";

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

test("rule suggestion mutations require internal auth even with same-origin headers", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const routes = [
    "/api/rules/suggestions/1/approve",
    "/api/rules/suggestions/1/reject"
  ];

  for (const url of routes) {
    const response = await app.inject({
      method: "POST",
      url,
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000"
      }
    });
    assert.equal(response.statusCode, 401);
  }
});

test("repo graph endpoint returns 400 for invalid repo id without querying Prisma", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const originalGraphNodeFindMany = prisma.graphNode.findMany;
  const originalGraphEdgeFindMany = prisma.graphEdge.findMany;
  let graphNodeCalled = false;
  let graphEdgeCalled = false;

  prisma.graphNode.findMany = (async () => {
    graphNodeCalled = true;
    return [];
  }) as typeof prisma.graphNode.findMany;
  prisma.graphEdge.findMany = (async () => {
    graphEdgeCalled = true;
    return [];
  }) as typeof prisma.graphEdge.findMany;

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/repos/not-a-number/graph",
      headers: { "x-internal-key": dashboardAuthKey() }
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "Invalid repo id" });
    assert.equal(graphNodeCalled, false);
    assert.equal(graphEdgeCalled, false);
  } finally {
    prisma.graphNode.findMany = originalGraphNodeFindMany;
    prisma.graphEdge.findMany = originalGraphEdgeFindMany;
  }
});

test("repo graph endpoint caps edge query size", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const originalGraphNodeFindMany = prisma.graphNode.findMany;
  const originalGraphEdgeFindMany = prisma.graphEdge.findMany;
  let graphEdgeQueryArgs: any = null;

  prisma.graphNode.findMany = (async () => {
    return [
      { id: 101, key: "src/a.ts" },
      { id: 102, key: "src/b.ts" }
    ];
  }) as typeof prisma.graphNode.findMany;
  prisma.graphEdge.findMany = (async (args: any) => {
    graphEdgeQueryArgs = args;
    return [
      { fromNodeId: 101, toNodeId: 102, type: "file_dep", data: { weight: 2 } }
    ];
  }) as typeof prisma.graphEdge.findMany;

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/repos/42/graph",
      headers: { "x-internal-key": dashboardAuthKey() }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(graphEdgeQueryArgs?.take, 20_000);
    assert.equal(graphEdgeQueryArgs?.where?.repoId, 42);
    assert.equal(response.json().edges.length, 1);
  } finally {
    prisma.graphNode.findMany = originalGraphNodeFindMany;
    prisma.graphEdge.findMany = originalGraphEdgeFindMany;
  }
});

test("recent reviews route falls back to safe limit when query limit is invalid", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const originalReviewRunFindMany = prisma.reviewRun.findMany;
  let reviewRunQueryArgs: any = null;
  prisma.reviewRun.findMany = (async (args: any) => {
    reviewRunQueryArgs = args;
    return [];
  }) as typeof prisma.reviewRun.findMany;

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/reviews/recent?limit=abc",
      headers: { "x-internal-key": dashboardAuthKey() }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(reviewRunQueryArgs?.take, 20);
    assert.deepEqual(response.json(), { items: [] });
  } finally {
    prisma.reviewRun.findMany = originalReviewRunFindMany;
  }
});

test("traversal analytics route falls back to safe limit when query limit is invalid", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const originalAnalyticsFindMany = prisma.analyticsEvent.findMany;
  let analyticsQueryArgs: any = null;
  prisma.analyticsEvent.findMany = (async (args: any) => {
    analyticsQueryArgs = args;
    return [
      {
        payload: {
          runId: 1,
          repoId: 1,
          relatedCount: 2,
          changedCount: 1,
          findingCount: 1,
          crossFileFindingCount: 1,
          crossFileRecall: 1,
          supportedPrecision: 1,
          supportedCount: 2,
          supportedByRetrievalCount: 1,
          supportedByGraphCount: 1,
          traversalMs: 100,
          visitedNodes: 80,
          traversedEdges: 120,
          prunedByBudget: 0,
          maxNodesVisited: 2400,
          repoFileCount: 80,
          repoSizeBucket: "small"
        }
      }
    ];
  }) as typeof prisma.analyticsEvent.findMany;

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/analytics/traversal?limit=abc",
      headers: { "x-internal-key": dashboardAuthKey() }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(analyticsQueryArgs?.take, 500);
  } finally {
    prisma.analyticsEvent.findMany = originalAnalyticsFindMany;
  }
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
