import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toolDefinitions, toolSchemas } from "../src/mcp/tool-defs.js";

function ensureIdeServerTestEnv(): void {
  const required: Record<string, string> = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/grepiku_test",
    REDIS_URL: "redis://localhost:6379",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "test-key",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENAI_COMPAT_BASE_URL: "https://example.test/v1",
    OPENAI_COMPAT_API_KEY: "test-openai-key",
    PROJECT_ROOT: process.cwd(),
    GREPIKU_IDE_ACTIVE_REPO: "owner/repo"
  };
  for (const [key, value] of Object.entries(required)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

async function loadIdeServerModule() {
  ensureIdeServerTestEnv();
  const [{ createMcpServer }, { prisma }] = await Promise.all([
    import("../src/mcp/ide-server.js"),
    import("../src/db/client.js")
  ]);
  return { createMcpServer, prisma };
}

// ---------------------------------------------------------------------------
// Tool registration tests
// ---------------------------------------------------------------------------

test("toolDefinitions contains all expected tool names", () => {
  const names = toolDefinitions.map((t) => t.name);
  assert.deepEqual(names, [
    "pr_listComments",
    "pr_getUnaddressed",
    "pr_applySuggestion",
    "patterns_search",
    "standards_list",
    "standards_add",
    "reports_weekly"
  ]);
});

test("every tool definition has a description", () => {
  for (const tool of toolDefinitions) {
    assert.ok(
      typeof tool.description === "string" && tool.description.length > 0,
      `Tool ${tool.name} should have a non-empty description`
    );
  }
});

test("every tool definition has a schema object", () => {
  for (const tool of toolDefinitions) {
    assert.ok(tool.schema !== null && typeof tool.schema === "object", `Tool ${tool.name} should have a schema`);
  }
});

// ---------------------------------------------------------------------------
// pr_listComments schema validation
// ---------------------------------------------------------------------------

test("pr_listComments schema accepts valid args", () => {
  const schema = z.object(toolSchemas.pr_listComments);
  const result = schema.safeParse({ repo: "owner/repo", prNumber: 42 });
  assert.ok(result.success, "Should accept valid repo and prNumber");
});

test("pr_listComments schema rejects missing repo", () => {
  const schema = z.object(toolSchemas.pr_listComments);
  const result = schema.safeParse({ prNumber: 42 });
  assert.ok(!result.success, "Should reject when repo is missing");
});

test("pr_listComments schema rejects non-integer prNumber", () => {
  const schema = z.object(toolSchemas.pr_listComments);
  const result = schema.safeParse({ repo: "owner/repo", prNumber: 3.14 });
  assert.ok(!result.success, "Should reject non-integer prNumber");
});

test("pr_listComments schema rejects negative prNumber", () => {
  const schema = z.object(toolSchemas.pr_listComments);
  const result = schema.safeParse({ repo: "owner/repo", prNumber: -1 });
  assert.ok(!result.success, "Should reject negative prNumber");
});

// ---------------------------------------------------------------------------
// pr_getUnaddressed schema validation
// ---------------------------------------------------------------------------

test("pr_getUnaddressed schema accepts valid args", () => {
  const schema = z.object(toolSchemas.pr_getUnaddressed);
  const result = schema.safeParse({ repo: "org/project", prNumber: 100 });
  assert.ok(result.success, "Should accept valid repo and prNumber");
});

test("pr_getUnaddressed schema rejects missing prNumber", () => {
  const schema = z.object(toolSchemas.pr_getUnaddressed);
  const result = schema.safeParse({ repo: "org/project" });
  assert.ok(!result.success, "Should reject when prNumber is missing");
});

// ---------------------------------------------------------------------------
// pr_applySuggestion schema validation
// ---------------------------------------------------------------------------

test("pr_applySuggestion schema accepts valid repo and findingId", () => {
  const schema = z.object(toolSchemas.pr_applySuggestion);
  const result = schema.safeParse({ repo: "owner/repo", findingId: 1 });
  assert.ok(result.success, "Should accept valid repo and findingId");
});

test("pr_applySuggestion schema rejects zero findingId", () => {
  const schema = z.object(toolSchemas.pr_applySuggestion);
  const result = schema.safeParse({ repo: "owner/repo", findingId: 0 });
  assert.ok(!result.success, "Should reject zero findingId");
});

test("pr_applySuggestion schema rejects string findingId", () => {
  const schema = z.object(toolSchemas.pr_applySuggestion);
  const result = schema.safeParse({ repo: "owner/repo", findingId: "abc" });
  assert.ok(!result.success, "Should reject string findingId");
});

test("pr_applySuggestion schema rejects missing repo", () => {
  const schema = z.object(toolSchemas.pr_applySuggestion);
  const result = schema.safeParse({ findingId: 1 });
  assert.ok(!result.success, "Should reject when repo is missing");
});

// ---------------------------------------------------------------------------
// patterns_search schema validation
// ---------------------------------------------------------------------------

test("patterns_search schema accepts valid args", () => {
  const schema = z.object(toolSchemas.patterns_search);
  const result = schema.safeParse({ repo: "owner/repo", query: "security" });
  assert.ok(result.success, "Should accept valid repo and query");
});

test("patterns_search schema rejects missing query", () => {
  const schema = z.object(toolSchemas.patterns_search);
  const result = schema.safeParse({ repo: "owner/repo" });
  assert.ok(!result.success, "Should reject when query is missing");
});

test("patterns_search schema rejects oversized query", () => {
  const schema = z.object(toolSchemas.patterns_search);
  const result = schema.safeParse({ repo: "owner/repo", query: "x".repeat(201) });
  assert.ok(!result.success, "Should reject oversized pattern queries");
});

// ---------------------------------------------------------------------------
// standards_list schema validation
// ---------------------------------------------------------------------------

test("standards_list schema accepts valid repo", () => {
  const schema = z.object(toolSchemas.standards_list);
  const result = schema.safeParse({ repo: "owner/repo" });
  assert.ok(result.success, "Should accept valid repo");
});

test("standards_list schema rejects empty input", () => {
  const schema = z.object(toolSchemas.standards_list);
  const result = schema.safeParse({});
  assert.ok(!result.success, "Should reject when repo is missing");
});

// ---------------------------------------------------------------------------
// standards_add schema validation
// ---------------------------------------------------------------------------

test("standards_add schema accepts valid args", () => {
  const schema = z.object(toolSchemas.standards_add);
  const result = schema.safeParse({ repo: "owner/repo", text: "Always use strict mode" });
  assert.ok(result.success, "Should accept valid repo and text");
});

test("standards_add schema rejects empty text", () => {
  const schema = z.object(toolSchemas.standards_add);
  const result = schema.safeParse({ repo: "owner/repo", text: "" });
  assert.ok(!result.success, "Should reject empty text");
});

test("standards_add schema rejects missing text", () => {
  const schema = z.object(toolSchemas.standards_add);
  const result = schema.safeParse({ repo: "owner/repo" });
  assert.ok(!result.success, "Should reject when text is missing");
});

// ---------------------------------------------------------------------------
// reports_weekly schema validation
// ---------------------------------------------------------------------------

test("reports_weekly schema accepts valid repo", () => {
  const schema = z.object(toolSchemas.reports_weekly);
  const result = schema.safeParse({ repo: "owner/repo" });
  assert.ok(result.success, "Should accept valid repo");
});

test("reports_weekly schema rejects numeric repo", () => {
  const schema = z.object(toolSchemas.reports_weekly);
  const result = schema.safeParse({ repo: 123 });
  assert.ok(!result.success, "Should reject numeric repo");
});

test("buildIdeStandardSuggestion keeps IDE-added standards pending for review", async () => {
  const { __ideServerInternals } = await import("../src/mcp/ide-server.js");
  const suggestion = __ideServerInternals.buildIdeStandardSuggestion(
    "Always validate webhook payload sizes before parsing them"
  );

  assert.equal(suggestion.status, "pending");
  assert.equal(suggestion.reason, "memory:always validate webhook payload sizes before parsing them");
  assert.equal(suggestion.ruleJson.source, "ide_mcp");
});

test("parseGithubRepoFullNameFromRemote normalizes GitHub remotes", async () => {
  const { __ideServerInternals } = await import("../src/mcp/ide-server.js");

  assert.equal(
    __ideServerInternals.parseGithubRepoFullNameFromRemote(
      "https://github.com/Owner/Repo.git"
    ),
    "owner/repo"
  );
  assert.equal(
    __ideServerInternals.parseGithubRepoFullNameFromRemote(
      "git@github.com:Owner/Repo.git"
    ),
    "owner/repo"
  );
  assert.equal(
    __ideServerInternals.parseGithubRepoFullNameFromRemote(
      "https://example.com/not-github/repo.git"
    ),
    null
  );
});

test("assertIdeRepoScope blocks cross-repo MCP access", async () => {
  const { __ideServerInternals } = await import("../src/mcp/ide-server.js");

  assert.equal(
    __ideServerInternals.assertIdeRepoScope("Owner/Repo", "owner/repo"),
    "owner/repo"
  );
  assert.throws(
    () => __ideServerInternals.assertIdeRepoScope("other/repo", "owner/repo"),
    /outside the active repository/i
  );
});

test("resolveConfiguredIdeActiveRepoFullName requires explicit configured scope", async () => {
  const { __ideServerInternals } = await import("../src/mcp/ide-server.js");

  assert.equal(
    __ideServerInternals.resolveConfiguredIdeActiveRepoFullName("Owner/Repo"),
    "owner/repo"
  );
  assert.equal(
    __ideServerInternals.resolveConfiguredIdeActiveRepoFullName(
      "https://github.com/Owner/Repo.git"
    ),
    "owner/repo"
  );
  assert.throws(
    () => __ideServerInternals.resolveConfiguredIdeActiveRepoFullName(""),
    /GREPIKU_IDE_ACTIVE_REPO/i
  );
});

test("pr_listComments bounds IDE comment queries and selects only the fields it returns", async () => {
  const { createMcpServer, prisma } = await loadIdeServerModule();
  const server = createMcpServer() as any;

  const originalRepoFindFirst = prisma.repo.findFirst;
  const originalPullRequestFindFirst = prisma.pullRequest.findFirst;
  const originalReviewCommentFindMany = prisma.reviewComment.findMany;
  let capturedArgs: Record<string, unknown> | null = null;

  prisma.repo.findFirst = (async () => ({ id: 11 })) as typeof prisma.repo.findFirst;
  prisma.pullRequest.findFirst = (async () => ({ id: 22 })) as typeof prisma.pullRequest.findFirst;
  prisma.reviewComment.findMany = (async (args: Record<string, unknown>) => {
    capturedArgs = args;
    return [];
  }) as typeof prisma.reviewComment.findMany;

  try {
    const result = await server._registeredTools.pr_listComments.handler({
      repo: "owner/repo",
      prNumber: 7
    });

    assert.deepEqual(result, {
      content: [{ type: "text", text: "[]" }]
    });
    assert.equal(capturedArgs?.take, 200);
    assert.deepEqual(capturedArgs?.select, {
      id: true,
      kind: true,
      body: true,
      url: true,
      finding: {
        select: {
          id: true,
          status: true,
          severity: true,
          category: true,
          title: true,
          path: true,
          line: true
        }
      }
    });
  } finally {
    prisma.repo.findFirst = originalRepoFindFirst;
    prisma.pullRequest.findFirst = originalPullRequestFindFirst;
    prisma.reviewComment.findMany = originalReviewCommentFindMany;
  }
});

test("pr_getUnaddressed bounds IDE finding queries", async () => {
  const { createMcpServer, prisma } = await loadIdeServerModule();
  const server = createMcpServer() as any;

  const originalRepoFindFirst = prisma.repo.findFirst;
  const originalPullRequestFindFirst = prisma.pullRequest.findFirst;
  const originalFindingFindMany = prisma.finding.findMany;
  let capturedArgs: Record<string, unknown> | null = null;

  prisma.repo.findFirst = (async () => ({ id: 11 })) as typeof prisma.repo.findFirst;
  prisma.pullRequest.findFirst = (async () => ({ id: 22 })) as typeof prisma.pullRequest.findFirst;
  prisma.finding.findMany = (async (args: Record<string, unknown>) => {
    capturedArgs = args;
    return [];
  }) as typeof prisma.finding.findMany;

  try {
    const result = await server._registeredTools.pr_getUnaddressed.handler({
      repo: "owner/repo",
      prNumber: 7
    });

    assert.deepEqual(result, {
      content: [{ type: "text", text: "[]" }]
    });
    assert.equal(capturedArgs?.take, 200);
  } finally {
    prisma.repo.findFirst = originalRepoFindFirst;
    prisma.pullRequest.findFirst = originalPullRequestFindFirst;
    prisma.finding.findMany = originalFindingFindMany;
  }
});

test("reports_weekly bounds IDE weekly-report queries", async () => {
  const { createMcpServer, prisma } = await loadIdeServerModule();
  const server = createMcpServer() as any;

  const originalRepoFindFirst = prisma.repo.findFirst;
  const originalReviewRunCount = prisma.reviewRun.count;
  const originalReviewRunFindMany = prisma.reviewRun.findMany;
  const originalFindingGroupBy = prisma.finding.groupBy;
  const originalFeedbackFindMany = prisma.feedback.findMany;
  const originalReviewCommentFindMany = prisma.reviewComment.findMany;

  let reviewRunFindManyCalled = false;
  let feedbackArgs: Record<string, unknown> | null = null;

  prisma.repo.findFirst = (async () => ({ id: 11 })) as typeof prisma.repo.findFirst;
  prisma.reviewRun.count = (async (args: Record<string, unknown>) => {
    const status = (args.where as { status?: string } | undefined)?.status;
    if (status === "completed") return 2;
    if (status === "failed") return 1;
    return 3;
  }) as typeof prisma.reviewRun.count;
  prisma.reviewRun.findMany = (async () => {
    reviewRunFindManyCalled = true;
    return [];
  }) as typeof prisma.reviewRun.findMany;
  prisma.finding.groupBy = (async (args: Record<string, unknown>) => {
    const by = (args.by as string[]) || [];
    if (by.length === 1 && by[0] === "severity") {
      return [{ severity: "high", _count: { _all: 2 } }];
    }
    if (by.length === 1 && by[0] === "category") {
      return [{ category: "security", _count: { _all: 2 } }];
    }
    return [];
  }) as typeof prisma.finding.groupBy;
  prisma.feedback.findMany = (async (args: Record<string, unknown>) => {
    feedbackArgs = args;
    return [];
  }) as typeof prisma.feedback.findMany;
  prisma.reviewComment.findMany = (async () => []) as typeof prisma.reviewComment.findMany;

  try {
    const result = await server._registeredTools.reports_weekly.handler({
      repo: "owner/repo"
    });
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(reviewRunFindManyCalled, false);
    assert.equal(feedbackArgs?.take, 2000);
    assert.deepEqual(feedbackArgs?.select, {
      type: true,
      sentiment: true,
      action: true,
      commentId: true,
      metadata: true
    });
    assert.deepEqual(parsed, {
      period: {
        from: parsed.period.from,
        to: parsed.period.to
      },
      runs: { total: 3, completed: 2, failed: 1 },
      findings: {
        total: 2,
        bySeverity: { high: 2 },
        byCategory: { security: 2 }
      },
      feedback: {
        positive: 0,
        negative: 0,
        trustedCount: 0,
        acceptanceRate: "N/A"
      }
    });
  } finally {
    prisma.repo.findFirst = originalRepoFindFirst;
    prisma.reviewRun.count = originalReviewRunCount;
    prisma.reviewRun.findMany = originalReviewRunFindMany;
    prisma.finding.groupBy = originalFindingGroupBy;
    prisma.feedback.findMany = originalFeedbackFindMany;
    prisma.reviewComment.findMany = originalReviewCommentFindMany;
  }
});
