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

test("csvCell quotes fields and neutralizes spreadsheet formulas", async () => {
  const { csvCell } = await loadDashboardInternals();

  assert.equal(csvCell('=HYPERLINK("https://evil.example")'), `"'=HYPERLINK(""https://evil.example"")"`);
  assert.equal(csvCell('plain,value'), `"plain,value"`);
  assert.equal(csvCell('"quoted"'), `"""quoted"""`);
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

test("dashboard HTML does not load third-party hosted fonts", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const response = await app.inject({
    method: "GET",
    url: "/dashboard",
    headers: { "x-internal-key": dashboardAuthKey() }
  });

  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /fonts\.googleapis\.com/i);
  assert.doesNotMatch(response.body, /fonts\.gstatic\.com/i);
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

test("rule suggestion mutations reject cross-origin browser requests even with valid Basic auth", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const auth = Buffer.from(`dashboard:${dashboardAuthKey()}`, "utf8").toString("base64");
  const originalFindFirst = prisma.ruleSuggestion.findFirst;
  let suggestionLookupCalled = false;
  prisma.ruleSuggestion.findFirst = (async () => {
    suggestionLookupCalled = true;
    return null;
  }) as typeof prisma.ruleSuggestion.findFirst;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/rules/suggestions/1/approve",
      headers: {
        authorization: `Basic ${auth}`,
        host: "grepiku.example",
        origin: "https://evil.example"
      }
    });

    assert.equal(response.statusCode, 401);
    assert.equal(suggestionLookupCalled, false);
  } finally {
    prisma.ruleSuggestion.findFirst = originalFindFirst;
  }
});

test("rule suggestion mutations reject invalid numeric ids before querying Prisma", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const originalFindFirst = prisma.ruleSuggestion.findFirst;
  const originalUpdate = prisma.ruleSuggestion.update;
  let findFirstCalled = false;
  let updateCalled = false;

  prisma.ruleSuggestion.findFirst = (async () => {
    findFirstCalled = true;
    return null;
  }) as typeof prisma.ruleSuggestion.findFirst;
  prisma.ruleSuggestion.update = (async () => {
    updateCalled = true;
    throw new Error("should not be called");
  }) as typeof prisma.ruleSuggestion.update;

  try {
    const approve = await app.inject({
      method: "POST",
      url: "/api/rules/suggestions/not-a-number/approve",
      headers: { "x-internal-key": dashboardAuthKey() }
    });
    assert.equal(approve.statusCode, 400);
    assert.deepEqual(approve.json(), { error: "Invalid rule suggestion id" });

    const reject = await app.inject({
      method: "POST",
      url: "/api/rules/suggestions/not-a-number/reject",
      headers: { "x-internal-key": dashboardAuthKey() }
    });
    assert.equal(reject.statusCode, 400);
    assert.deepEqual(reject.json(), { error: "Invalid rule suggestion id" });

    assert.equal(findFirstCalled, false);
    assert.equal(updateCalled, false);
  } finally {
    prisma.ruleSuggestion.findFirst = originalFindFirst;
    prisma.ruleSuggestion.update = originalUpdate;
  }
});

test("rule suggestion reject returns 404 when the suggestion does not exist", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const originalFindFirst = prisma.ruleSuggestion.findFirst;
  const originalUpdate = prisma.ruleSuggestion.update;
  let updateCalled = false;

  prisma.ruleSuggestion.findFirst = (async () => null) as typeof prisma.ruleSuggestion.findFirst;
  prisma.ruleSuggestion.update = (async () => {
    updateCalled = true;
    throw new Error("should not update missing suggestion");
  }) as typeof prisma.ruleSuggestion.update;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/rules/suggestions/999/reject",
      headers: { "x-internal-key": dashboardAuthKey() }
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "Not found" });
    assert.equal(updateCalled, false);
  } finally {
    prisma.ruleSuggestion.findFirst = originalFindFirst;
    prisma.ruleSuggestion.update = originalUpdate;
  }
});

test("rule suggestion approve does not append duplicate rules into repo config", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const existingRule = {
    id: "memory-no-console",
    title: "Avoid console.log",
    pattern: "Avoid console.log",
    commentType: "inline"
  };
  const suggestion = {
    id: 12,
    repoId: 55,
    reason: "memory:avoid console.log",
    status: "pending",
    ruleJson: existingRule
  };
  const repoConfig = {
    id: 9,
    repoId: 55,
    configJson: {
      rules: [existingRule]
    }
  };

  const originalSuggestionFindFirst = prisma.ruleSuggestion.findFirst;
  const originalSuggestionUpdate = prisma.ruleSuggestion.update;
  const originalRepoConfigFindFirst = prisma.repoConfig.findFirst;
  const originalRepoConfigUpdate = prisma.repoConfig.update;
  const originalTransaction = prisma.$transaction;
  let updatedConfigJson: any = null;

  prisma.ruleSuggestion.findFirst = (async () => suggestion) as typeof prisma.ruleSuggestion.findFirst;
  prisma.ruleSuggestion.update = (async () => suggestion) as typeof prisma.ruleSuggestion.update;
  prisma.repoConfig.findFirst = (async () => repoConfig) as typeof prisma.repoConfig.findFirst;
  prisma.repoConfig.update = (async (args: any) => {
    updatedConfigJson = args.data.configJson;
    return { ...repoConfig, configJson: args.data.configJson };
  }) as typeof prisma.repoConfig.update;
  prisma.$transaction = (async (callback: any) =>
    callback({
      ruleSuggestion: prisma.ruleSuggestion,
      repoConfig: prisma.repoConfig
    })) as typeof prisma.$transaction;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/rules/suggestions/12/approve",
      headers: { "x-internal-key": dashboardAuthKey() }
    });

    assert.equal(response.statusCode, 200);
    const finalConfigJson = updatedConfigJson ?? repoConfig.configJson;
    assert.equal(Array.isArray(finalConfigJson.rules), true);
    assert.equal(finalConfigJson.rules.length, 1);
    assert.deepEqual(finalConfigJson.rules[0], existingRule);
  } finally {
    prisma.ruleSuggestion.findFirst = originalSuggestionFindFirst;
    prisma.ruleSuggestion.update = originalSuggestionUpdate;
    prisma.repoConfig.findFirst = originalRepoConfigFindFirst;
    prisma.repoConfig.update = originalRepoConfigUpdate;
    prisma.$transaction = originalTransaction;
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

test("analytics summary ignores untrusted or untracked feedback when computing acceptance rate", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const originalReviewRunFindMany = prisma.reviewRun.findMany;
  const originalFeedbackFindMany = prisma.feedback.findMany;
  const originalReviewCommentFindMany = prisma.reviewComment.findMany;
  const originalFindingFindMany = prisma.finding.findMany;
  const originalReviewRunCount = prisma.reviewRun.count;
  let reviewRunQueryArgs: any = null;
  let feedbackQueryArgs: any = null;

  prisma.reviewRun.count = (async () => 123) as typeof prisma.reviewRun.count;
  prisma.reviewRun.findMany = (async (args: any) => {
    reviewRunQueryArgs = args;
    return [];
  }) as typeof prisma.reviewRun.findMany;
  prisma.feedback.findMany = (async (args: any) => {
    feedbackQueryArgs = args;
    return [
      {
        commentId: "bot-summary-1",
        type: "reaction",
        sentiment: "thumbs_up",
        action: null,
        metadata: { authorAssociation: "OWNER" }
      },
      {
        commentId: "human-comment-1",
        type: "reaction",
        sentiment: "thumbs_down",
        action: null,
        metadata: { authorAssociation: "COLLABORATOR" }
      },
      {
        commentId: "bot-summary-2",
        type: "reaction",
        sentiment: "thumbs_down",
        action: null,
        metadata: { authorAssociation: "CONTRIBUTOR" }
      }
    ];
  }) as typeof prisma.feedback.findMany;
  prisma.reviewComment.findMany = (async () => [
    { providerCommentId: "bot-summary-1" }
  ]) as typeof prisma.reviewComment.findMany;
  prisma.finding.findMany = (async () => []) as typeof prisma.finding.findMany;

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/analytics/summary",
      headers: { "x-internal-key": dashboardAuthKey() }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().acceptanceRate, 100);
    assert.equal(response.json().runCount, 123);
    assert.equal(reviewRunQueryArgs?.take, 5000);
    assert.deepEqual(reviewRunQueryArgs?.select, { startedAt: true, completedAt: true });
    assert.equal(feedbackQueryArgs?.take, 10000);
    assert.deepEqual(feedbackQueryArgs?.select, {
      type: true,
      sentiment: true,
      action: true,
      commentId: true,
      metadata: true
    });
  } finally {
    prisma.reviewRun.count = originalReviewRunCount;
    prisma.reviewRun.findMany = originalReviewRunFindMany;
    prisma.feedback.findMany = originalFeedbackFindMany;
    prisma.reviewComment.findMany = originalReviewCommentFindMany;
    prisma.finding.findMany = originalFindingFindMany;
  }
});

test("analytics insights route bounds findings reads with minimal columns", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const originalFindingFindMany = prisma.finding.findMany;
  let findingQueryArgs: any = null;
  prisma.finding.findMany = (async (args: any) => {
    findingQueryArgs = args;
    return [];
  }) as typeof prisma.finding.findMany;

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/analytics/insights",
      headers: { "x-internal-key": dashboardAuthKey() }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(findingQueryArgs?.take, 20000);
    assert.deepEqual(findingQueryArgs?.select, {
      category: true,
      path: true
    });
  } finally {
    prisma.finding.findMany = originalFindingFindMany;
  }
});

test("analytics export route bounds event reads with minimal columns", async (t) => {
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
    return [];
  }) as typeof prisma.analyticsEvent.findMany;

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/analytics/export?format=json",
      headers: { "x-internal-key": dashboardAuthKey() }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(analyticsQueryArgs?.take, 50000);
    assert.deepEqual(analyticsQueryArgs?.select, {
      id: true,
      repoId: true,
      runId: true,
      kind: true,
      createdAt: true,
      payload: true
    });
  } finally {
    prisma.analyticsEvent.findMany = originalAnalyticsFindMany;
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

test("analytics routes reject invalid repoId filters before querying Prisma", async (t) => {
  const { registerDashboard } = await loadDashboardModule();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
  });
  registerDashboard(app);

  const originalAnalyticsFindMany = prisma.analyticsEvent.findMany;
  const originalFindingGroupBy = prisma.finding.groupBy;
  const originalFindingWeightFindMany = prisma.findingWeight.findMany;
  let analyticsCalled = false;
  let findingGroupCalled = false;
  let weightsCalled = false;

  prisma.analyticsEvent.findMany = (async () => {
    analyticsCalled = true;
    return [];
  }) as typeof prisma.analyticsEvent.findMany;
  prisma.finding.groupBy = (async () => {
    findingGroupCalled = true;
    return [];
  }) as typeof prisma.finding.groupBy;
  prisma.findingWeight.findMany = (async () => {
    weightsCalled = true;
    return [];
  }) as typeof prisma.findingWeight.findMany;

  try {
    const headers = { "x-internal-key": dashboardAuthKey() };

    const traversal = await app.inject({
      method: "GET",
      url: "/api/analytics/traversal?repoId=abc",
      headers
    });
    assert.equal(traversal.statusCode, 400);
    assert.deepEqual(traversal.json(), { error: "Invalid repo id" });

    const findings = await app.inject({
      method: "GET",
      url: "/api/analytics/findings-by-severity?repoId=abc",
      headers
    });
    assert.equal(findings.statusCode, 400);
    assert.deepEqual(findings.json(), { error: "Invalid repo id" });

    const weights = await app.inject({
      method: "GET",
      url: "/api/analytics/weights?repoId=abc",
      headers
    });
    assert.equal(weights.statusCode, 400);
    assert.deepEqual(weights.json(), { error: "Invalid repo id" });

    assert.equal(analyticsCalled, false);
    assert.equal(findingGroupCalled, false);
    assert.equal(weightsCalled, false);
  } finally {
    prisma.analyticsEvent.findMany = originalAnalyticsFindMany;
    prisma.finding.groupBy = originalFindingGroupBy;
    prisma.findingWeight.findMany = originalFindingWeightFindMany;
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
