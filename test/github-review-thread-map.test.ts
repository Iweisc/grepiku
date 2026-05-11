import assert from "node:assert/strict";
import crypto from "node:crypto";
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

test("loadGithubReviewThreadMap caps retained review comments and stops paginating", async () => {
  ensureTestEnv();
  const { loadGithubReviewThreadMap } = await import("../src/providers/github/adapter.js");
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const graphql = async (query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables });

    if (query.includes("reviewThreads(first: 100")) {
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "THREAD_1",
                  isResolved: false,
                  comments: {
                    nodes: [
                      { databaseId: 1 },
                      { databaseId: 2 },
                      { databaseId: 3 },
                      { databaseId: 4 }
                    ],
                    pageInfo: { hasNextPage: true, endCursor: "THREAD_1_C4" }
                  }
                }
              ],
              pageInfo: { hasNextPage: true, endCursor: "THREAD_PAGE_2" }
            }
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
    pullNumber: 42,
    maxCommentIds: 3
  });

  assert.equal(map.size, 3);
  assert.deepEqual(map.get("1"), { threadId: "THREAD_1", isResolved: false });
  assert.deepEqual(map.get("3"), { threadId: "THREAD_1", isResolved: false });
  assert.equal(map.has("4"), false);
  assert.equal(calls.length, 1);
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

test("verifyWebhook preserves GitHub comment author association", async () => {
  ensureTestEnv();
  const { createGithubAdapter } = await import("../src/providers/github/adapter.js");
  const adapter = createGithubAdapter();
  const body = JSON.stringify({
    action: "created",
    installation: { id: 99 },
    repository: {
      id: 1,
      owner: { login: "acme" },
      name: "widgets",
      full_name: "acme/widgets",
      default_branch: "main",
      archived: false,
      private: false,
      html_url: "https://github.com/acme/widgets"
    },
    issue: {
      id: 77,
      number: 12,
      title: "Fix bug",
      body: "PR body",
      html_url: "https://github.com/acme/widgets/pull/12",
      state: "open",
      pull_request: {}
    },
    comment: {
      id: 55,
      body: "/review",
      html_url: "https://github.com/acme/widgets/pull/12#issuecomment-55",
      author_association: "MEMBER",
      user: {
        id: 42,
        login: "octocat",
        avatar_url: "https://avatars.example/octocat"
      }
    },
    sender: {
      id: 42,
      login: "octocat",
      avatar_url: "https://avatars.example/octocat"
    },
    pull_request: {
      id: 77,
      number: 12,
      title: "Fix bug",
      body: "PR body",
      html_url: "https://github.com/acme/widgets/pull/12",
      state: "open",
      base: { ref: "main", sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
      head: { ref: "feature/fix", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
      user: { id: 42, login: "octocat" }
    }
  });
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(body, "utf8").digest("hex")}`;

  const event = await adapter.verifyWebhook({
    headers: {
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": signature
    },
    body
  });

  assert.ok(event);
  assert.equal(event.type, "comment");
  assert.equal(event.author.association, "MEMBER");
});

test("verifyWebhook ignores edited issue comments so comment commands only run on fresh comments", async () => {
  ensureTestEnv();
  const { createGithubAdapter } = await import("../src/providers/github/adapter.js");
  const adapter = createGithubAdapter();
  const body = JSON.stringify({
    action: "edited",
    installation: { id: 99 },
    repository: {
      id: 1,
      owner: { login: "acme" },
      name: "widgets",
      full_name: "acme/widgets",
      default_branch: "main",
      archived: false,
      private: false,
      html_url: "https://github.com/acme/widgets"
    },
    issue: {
      id: 77,
      number: 12,
      title: "Fix bug",
      body: "PR body",
      html_url: "https://github.com/acme/widgets/pull/12",
      state: "open",
      pull_request: {}
    },
    comment: {
      id: 55,
      body: "/review",
      html_url: "https://github.com/acme/widgets/pull/12#issuecomment-55",
      author_association: "MEMBER",
      user: {
        id: 42,
        login: "octocat",
        avatar_url: "https://avatars.example/octocat"
      }
    },
    sender: {
      id: 42,
      login: "octocat",
      avatar_url: "https://avatars.example/octocat"
    },
    pull_request: {
      id: 77,
      number: 12,
      title: "Fix bug",
      body: "PR body",
      html_url: "https://github.com/acme/widgets/pull/12",
      state: "open",
      base: { ref: "main", sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
      head: { ref: "feature/fix", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
      user: { id: 42, login: "octocat" }
    }
  });
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(body, "utf8").digest("hex")}`;

  const event = await adapter.verifyWebhook({
    headers: {
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-issue-comment-edited",
      "x-hub-signature-256": signature
    },
    body
  });

  assert.equal(event, null);
});

test("verifyWebhook ignores deleted review comments so stale thread events do not trigger runs", async () => {
  ensureTestEnv();
  const { createGithubAdapter } = await import("../src/providers/github/adapter.js");
  const adapter = createGithubAdapter();
  const body = JSON.stringify({
    action: "deleted",
    installation: { id: 99 },
    repository: {
      id: 1,
      owner: { login: "acme" },
      name: "widgets",
      full_name: "acme/widgets",
      default_branch: "main",
      archived: false,
      private: false,
      html_url: "https://github.com/acme/widgets"
    },
    comment: {
      id: 78,
      body: "@grepiku can you re-check this?",
      html_url: "https://github.com/acme/widgets/pull/12#discussion_r78",
      author_association: "MEMBER",
      path: "src/index.ts",
      line: 10,
      side: "RIGHT",
      user: {
        id: 42,
        login: "octocat",
        avatar_url: "https://avatars.example/octocat"
      }
    },
    pull_request: {
      id: 77,
      number: 12,
      title: "Fix bug",
      body: "PR body",
      html_url: "https://github.com/acme/widgets/pull/12",
      state: "open",
      base: { ref: "main", sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
      head: { ref: "feature/fix", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
      user: { id: 42, login: "octocat" }
    },
    sender: {
      id: 42,
      login: "octocat",
      avatar_url: "https://avatars.example/octocat"
    }
  });
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(body, "utf8").digest("hex")}`;

  const event = await adapter.verifyWebhook({
    headers: {
      "x-github-event": "pull_request_review_comment",
      "x-github-delivery": "delivery-review-comment-deleted",
      "x-hub-signature-256": signature
    },
    body
  });

  assert.equal(event, null);
});

test("verifyWebhook records reaction actor from sender instead of the commented-on user", async () => {
  ensureTestEnv();
  const { createGithubAdapter } = await import("../src/providers/github/adapter.js");
  const adapter = createGithubAdapter();
  const body = JSON.stringify({
    action: "created",
    installation: { id: 99 },
    repository: {
      id: 1,
      owner: { login: "acme" },
      name: "widgets",
      full_name: "acme/widgets",
      default_branch: "main",
      archived: false,
      private: false,
      html_url: "https://github.com/acme/widgets"
    },
    reaction: {
      content: "thumbs_down"
    },
    comment: {
      id: 55,
      body: "Looks wrong",
      html_url: "https://github.com/acme/widgets/pull/12#issuecomment-55",
      author_association: "MEMBER",
      user: {
        id: 42,
        login: "grepiku-dev[bot]",
        avatar_url: "https://avatars.example/grepiku"
      }
    },
    sender: {
      id: 99,
      login: "outside-contributor",
      avatar_url: "https://avatars.example/outside"
    },
    pull_request: {
      id: 77,
      number: 12,
      title: "Fix bug",
      body: "PR body",
      html_url: "https://github.com/acme/widgets/pull/12",
      state: "open",
      base: { ref: "main", sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
      head: { ref: "feature/fix", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
      user: { id: 42, login: "octocat" }
    }
  });
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(body, "utf8").digest("hex")}`;

  const event = await adapter.verifyWebhook({
    headers: {
      "x-github-event": "reaction",
      "x-github-delivery": "delivery-2",
      "x-hub-signature-256": signature
    },
    body
  });

  assert.ok(event);
  assert.equal(event.type, "reaction");
  assert.equal(event.author.login, "outside-contributor");
  assert.equal(event.author.association, null);
});

test("verifyWebhook preserves reaction lifecycle action separately from reaction content", async () => {
  ensureTestEnv();
  const { createGithubAdapter } = await import("../src/providers/github/adapter.js");
  const adapter = createGithubAdapter();
  const body = JSON.stringify({
    action: "deleted",
    installation: { id: 99 },
    repository: {
      id: 1,
      owner: { login: "acme" },
      name: "widgets",
      full_name: "acme/widgets",
      default_branch: "main",
      archived: false,
      private: false,
      html_url: "https://github.com/acme/widgets"
    },
    reaction: {
      content: "thumbs_down"
    },
    comment: {
      id: 55,
      body: "Looks wrong",
      html_url: "https://github.com/acme/widgets/pull/12#issuecomment-55",
      author_association: "MEMBER",
      user: {
        id: 42,
        login: "grepiku-dev[bot]",
        avatar_url: "https://avatars.example/grepiku"
      }
    },
    sender: {
      id: 99,
      login: "outside-contributor",
      avatar_url: "https://avatars.example/outside"
    },
    pull_request: {
      id: 77,
      number: 12,
      title: "Fix bug",
      body: "PR body",
      html_url: "https://github.com/acme/widgets/pull/12",
      state: "open",
      base: { ref: "main", sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
      head: { ref: "feature/fix", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
      user: { id: 42, login: "octocat" }
    }
  });
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(body, "utf8").digest("hex")}`;

  const event = await adapter.verifyWebhook({
    headers: {
      "x-github-event": "reaction",
      "x-github-delivery": "delivery-4",
      "x-hub-signature-256": signature
    },
    body
  });

  assert.ok(event);
  assert.equal(event.type, "reaction");
  assert.equal(event.action, "deleted");
  assert.equal(event.reactionContent, "thumbs_down");
});

test("verifyWebhook ignores reactions on plain issues that are not pull-request feedback", async () => {
  ensureTestEnv();
  const { createGithubAdapter } = await import("../src/providers/github/adapter.js");
  const adapter = createGithubAdapter();
  const body = JSON.stringify({
    action: "created",
    installation: { id: 99 },
    repository: {
      id: 1,
      owner: { login: "acme" },
      name: "widgets",
      full_name: "acme/widgets",
      default_branch: "main",
      archived: false,
      private: false,
      html_url: "https://github.com/acme/widgets"
    },
    issue: {
      id: 88,
      number: 21,
      title: "Plain issue",
      body: "Issue body",
      html_url: "https://github.com/acme/widgets/issues/21",
      state: "open"
    },
    reaction: {
      content: "thumbs_up"
    },
    comment: {
      id: 56,
      body: "Thanks",
      html_url: "https://github.com/acme/widgets/issues/21#issuecomment-56",
      author_association: "CONTRIBUTOR",
      user: {
        id: 42,
        login: "octocat",
        avatar_url: "https://avatars.example/octocat"
      }
    },
    sender: {
      id: 99,
      login: "outside-contributor",
      avatar_url: "https://avatars.example/outside"
    }
  });
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(body, "utf8").digest("hex")}`;

  const event = await adapter.verifyWebhook({
    headers: {
      "x-github-event": "reaction",
      "x-github-delivery": "delivery-3",
      "x-hub-signature-256": signature
    },
    body
  });

  assert.equal(event, null);
});

test("verifyWebhook rejects signed reaction payloads replayed under the issue_comment header", async () => {
  ensureTestEnv();
  const { createGithubAdapter } = await import("../src/providers/github/adapter.js");
  const adapter = createGithubAdapter();
  const body = JSON.stringify({
    action: "created",
    installation: { id: 99 },
    repository: {
      id: 1,
      owner: { login: "acme" },
      name: "widgets",
      full_name: "acme/widgets",
      default_branch: "main",
      archived: false,
      private: false,
      html_url: "https://github.com/acme/widgets"
    },
    issue: {
      id: 77,
      number: 12,
      title: "Fix bug",
      body: "PR body",
      html_url: "https://github.com/acme/widgets/pull/12",
      state: "open",
      pull_request: {}
    },
    reaction: {
      content: "eyes"
    },
    comment: {
      id: 55,
      body: "/review",
      html_url: "https://github.com/acme/widgets/pull/12#issuecomment-55",
      author_association: "MEMBER",
      user: {
        id: 42,
        login: "octocat",
        avatar_url: "https://avatars.example/octocat"
      }
    },
    sender: {
      id: 99,
      login: "outside-contributor",
      avatar_url: "https://avatars.example/outside"
    }
  });
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(body, "utf8").digest("hex")}`;

  const event = await adapter.verifyWebhook({
    headers: {
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-reaction-replayed-as-comment",
      "x-hub-signature-256": signature
    },
    body
  });

  assert.equal(event, null);
});
