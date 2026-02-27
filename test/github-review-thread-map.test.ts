import assert from "node:assert/strict";
import test from "node:test";

function ensureTestEnv() {
  const defaults: Record<string, string> = {
    PORT: "3000",
    DATABASE_URL: "postgres://localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "test",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1",
    OPENAI_COMPAT_API_KEY: "test-key",
    PROJECT_ROOT: process.cwd()
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

test("loadGithubReviewThreadMap paginates comments after the first page", async () => {
  ensureTestEnv();
  const { loadGithubReviewThreadMap } = await import("../src/providers/github/adapter.js");
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const graphql = async (query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables });

    if (query.includes("reviewThreads(first: 100")) {
      const after = (variables.after ?? null) as string | null;
      if (!after) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "THREAD_1",
                    isResolved: false,
                    comments: {
                      nodes: Array.from({ length: 100 }, (_, index) => ({ databaseId: index + 1 })),
                      pageInfo: { hasNextPage: true, endCursor: "THREAD_1_C100" }
                    }
                  }
                ],
                pageInfo: { hasNextPage: true, endCursor: "THREAD_PAGE_2" }
              }
            }
          }
        };
      }

      assert.equal(after, "THREAD_PAGE_2");
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "THREAD_2",
                  isResolved: true,
                  comments: {
                    nodes: [{ databaseId: 220 }],
                    pageInfo: { hasNextPage: false, endCursor: null }
                  }
                }
              ],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        }
      };
    }

    if (query.includes("node(id: $threadId)")) {
      assert.equal(variables.threadId, "THREAD_1");
      assert.equal(variables.commentsAfter, "THREAD_1_C100");
      return {
        node: {
          comments: {
            nodes: Array.from({ length: 50 }, (_, index) => ({ databaseId: 101 + index })),
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      };
    }

    throw new Error("Unexpected GraphQL query");
  };

  const map = await loadGithubReviewThreadMap({
    graphql,
    owner: "acme",
    repo: "demo",
    pullNumber: 42
  });

  assert.deepEqual(map.get("1"), { threadId: "THREAD_1", isResolved: false });
  assert.deepEqual(map.get("150"), { threadId: "THREAD_1", isResolved: false });
  assert.deepEqual(map.get("220"), { threadId: "THREAD_2", isResolved: true });

  const reviewThreadQueryCalls = calls.filter((call) => call.query.includes("reviewThreads(first: 100"));
  const commentPageQueryCalls = calls.filter((call) => call.query.includes("node(id: $threadId)"));
  assert.equal(reviewThreadQueryCalls.length, 2);
  assert.equal(commentPageQueryCalls.length, 1);
});

test("isIntegrationPermissionDenied detects GitHub integration 403 errors", async () => {
  ensureTestEnv();
  const { __githubAdapterInternals } = await import("../src/providers/github/adapter.js");

  assert.equal(
    __githubAdapterInternals.isIntegrationPermissionDenied(
      new Error("Resource not accessible by integration")
    ),
    true
  );
  assert.equal(
    __githubAdapterInternals.isIntegrationPermissionDenied(
      new Error("The requested URL returned error: 403")
    ),
    true
  );
  assert.equal(
    __githubAdapterInternals.isIntegrationPermissionDenied(new Error("Validation failed")),
    false
  );
});
