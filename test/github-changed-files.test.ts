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

test("listGithubPullRequestFiles bounds provider fallback output without retaining patch blobs", async () => {
  ensureTestEnv();
  const { __githubAdapterInternals } = await import("../src/providers/github/adapter.js");
  const seenPages: number[] = [];

  const octokit = {
    pulls: { listFiles: Symbol("listFiles") },
    paginate: {
      iterator(_endpoint: unknown, params: Record<string, unknown>) {
        assert.equal(params.owner, "acme");
        assert.equal(params.repo, "demo");
        assert.equal(params.pull_number, 42);
        assert.equal(params.per_page, 100);

        async function* pages() {
          seenPages.push(1);
          yield {
            data: [
              {
                filename: "src/a.ts",
                status: "modified",
                additions: 10,
                deletions: 2,
                patch: "A".repeat(50_000)
              }
            ]
          };
          seenPages.push(2);
          yield {
            data: [
              {
                filename: "src/b.ts",
                status: "added",
                additions: 3,
                deletions: 0,
                patch: "B".repeat(50_000)
              }
            ]
          };
          seenPages.push(3);
          yield {
            data: [
              {
                filename: "src/c.ts",
                status: "removed",
                additions: 0,
                deletions: 7,
                patch: "C".repeat(50_000)
              }
            ]
          };
        }

        return pages();
      }
    }
  };

  const changedFiles = await __githubAdapterInternals.listGithubPullRequestFiles({
    octokit,
    owner: "acme",
    repo: "demo",
    pullNumber: 42,
    maxBytes: 160
  });

  assert.deepEqual(changedFiles, [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 10,
      deletions: 2
    },
    {
      path: "src/b.ts",
      status: "added",
      additions: 3,
      deletions: 0
    }
  ]);
  assert.deepEqual(seenPages, [1, 2, 3]);
});

test("listGithubReviewComments retains only matching inline comments during pagination", async () => {
  ensureTestEnv();
  const { __githubAdapterInternals } = await import("../src/providers/github/adapter.js");

  const octokit = {
    pulls: { listReviewComments: Symbol("listReviewComments") },
    paginate: {
      iterator(_endpoint: unknown, params: Record<string, unknown>) {
        assert.equal(params.owner, "acme");
        assert.equal(params.repo, "demo");
        assert.equal(params.pull_number, 42);
        assert.equal(params.per_page, 100);

        async function* pages() {
          yield {
            data: [
              {
                id: 1,
                body: "human review comment ".repeat(5000),
                html_url: "https://example.test/comments/1",
                path: "src/human.ts",
                line: 10,
                side: "RIGHT",
                created_at: "2026-03-23T00:00:00Z"
              }
            ]
          };
          yield {
            data: [
              {
                id: 2,
                body: "<!-- grepiku:abc123 -->\nBot review comment",
                html_url: "https://example.test/comments/2",
                path: "src/bot.ts",
                line: 12,
                side: "RIGHT",
                created_at: "2026-03-23T00:00:00Z"
              }
            ]
          };
        }

        return pages();
      }
    }
  };

  const comments = await __githubAdapterInternals.listGithubReviewComments({
    octokit,
    owner: "acme",
    repo: "demo",
    pullNumber: 42,
    bodyIncludes: "<!-- grepiku:"
  });

  assert.deepEqual(comments, [
    {
      id: "2",
      body: "<!-- grepiku:abc123 -->\nBot review comment",
      url: "https://example.test/comments/2",
      path: "src/bot.ts",
      line: 12,
      side: "RIGHT",
      createdAt: "2026-03-23T00:00:00Z"
    }
  ]);
});

test("listGithubReviewComments can require a verified bot author for marker-matching comments", async () => {
  ensureTestEnv();
  const { __githubAdapterInternals } = await import("../src/providers/github/adapter.js");

  const octokit = {
    pulls: { listReviewComments: Symbol("listReviewComments") },
    paginate: {
      iterator(_endpoint: unknown, params: Record<string, unknown>) {
        assert.equal(params.owner, "acme");
        assert.equal(params.repo, "demo");
        assert.equal(params.pull_number, 42);
        assert.equal(params.per_page, 100);

        async function* pages() {
          yield {
            data: [
              {
                id: 1,
                body: "<!-- grepiku:abc123 -->\nHuman spoofed marker comment",
                html_url: "https://example.test/comments/1",
                path: "src/human.ts",
                line: 10,
                side: "RIGHT",
                user: { login: "outside-contributor" },
                created_at: "2026-03-23T00:00:00Z"
              },
              {
                id: 2,
                body: "<!-- grepiku:abc123 -->\nReal bot marker comment",
                html_url: "https://example.test/comments/2",
                path: "src/bot.ts",
                line: 12,
                side: "RIGHT",
                user: { login: "grepiku-dev[bot]" },
                created_at: "2026-03-23T00:00:00Z"
              }
            ]
          };
        }

        return pages();
      }
    }
  };

  const comments = await __githubAdapterInternals.listGithubReviewComments({
    octokit,
    owner: "acme",
    repo: "demo",
    pullNumber: 42,
    bodyIncludes: "<!-- grepiku:",
    authorLogin: "grepiku-dev"
  } as any);

  assert.deepEqual(comments, [
    {
      id: "2",
      body: "<!-- grepiku:abc123 -->\nReal bot marker comment",
      url: "https://example.test/comments/2",
      path: "src/bot.ts",
      line: 12,
      side: "RIGHT",
      createdAt: "2026-03-23T00:00:00Z",
      authorLogin: "grepiku-dev[bot]"
    }
  ]);
});

test("fetchGithubPullRequestDiffWithinLimit treats oversized provider diffs as too large", async () => {
  ensureTestEnv();
  const { __githubAdapterInternals } = await import("../src/providers/github/adapter.js");

  await assert.rejects(
    __githubAdapterInternals.fetchGithubPullRequestDiffWithinLimit({
      url: "https://example.test/pulls/42.diff",
      token: "test-installation-token",
      maxBytes: 8,
      fetchImpl: async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
        assert.equal(init?.method, "GET");
        assert.equal(init?.headers instanceof Headers, true);
        assert.equal((init?.headers as Headers).get("authorization"), "Bearer test-installation-token");
        assert.equal(
          (init?.headers as Headers).get("accept"),
          "application/vnd.github.v3.diff"
        );

        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("12345"));
            controller.enqueue(encoder.encode("67890"));
            controller.close();
          }
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
    }),
    (error: any) => {
      assert.equal(error?.status, 406);
      assert.match(String(error?.message || ""), /diff exceeded/i);
      assert.deepEqual(error?.response?.data?.errors, [{ field: "diff", code: "too_large" }]);
      return true;
    }
  );
});
