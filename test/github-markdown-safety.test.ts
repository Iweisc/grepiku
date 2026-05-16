import test from "node:test";
import assert from "node:assert/strict";

function ensureReviewRenderTestEnv(): void {
  const required: Record<string, string> = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/grepiku_test",
    REDIS_URL: "redis://localhost:6379",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "test-key",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENAI_COMPAT_BASE_URL: "https://example.test/v1",
    OPENAI_COMPAT_API_KEY: "test-openai-key",
    PROJECT_ROOT: process.cwd(),
    INTERNAL_API_KEY: "test-internal-key"
  };
  for (const [key, value] of Object.entries(required)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

async function closeQueueClients(): Promise<void> {
  const { redisClient } = await import("../src/queue/index.js");
  await redisClient.quit().catch(() => undefined);
}

test("review status rendering neutralizes mentions and markdown-link injection", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const body = __pipelineInternals.renderStatusComment({
      summary: {
        overview: "See [urgent fix](https://evil.test) and ping @security/team",
        risk: "high",
        key_concerns: ["notify @owners", "follow [tracker](https://evil.test/ticket)"],
        what_to_test: ["open src/[boom](@team).ts"],
        file_breakdown: [
          {
            path: "src/[boom](@team).ts",
            summary: "touches <img src=x onerror=alert(1)>"
          }
        ]
      },
      newFindings: [
        {
          title: "[click me](https://evil.test) @ops/team",
          url: "https://github.com/acme/repo/pull/1#discussion_r1"
        }
      ],
      openFindings: [],
      fixedFindings: [],
      checks: {
        lint: { status: "pass", summary: "ok", top_errors: [] },
        build: { status: "pass", summary: "ok", top_errors: [] },
        test: { status: "pass", summary: "ok", top_errors: [] }
      },
      warnings: ["watch <img src=x onerror=alert(1)>"]
    });

    assert.doesNotMatch(body, /@security\/team/);
    assert.doesNotMatch(body, /@ops\/team/);
    assert.match(body, /@\u200bsecurity\/team/);
    assert.match(body, /@\u200bops\/team/);
    assert.match(body, /\\\[click me\\\]\\\(https:\/\/\u200bevil\.test\\\)/);
    assert.match(body, /&lt;img src=x onerror=alert\\\(1\\\)&gt;/);
  } finally {
    await closeQueueClients();
  }
});

test("inline review comment rendering neutralizes model-controlled markdown", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const body = __pipelineInternals.formatInlineComment({
      comment_id: "c1",
      severity: "important",
      title: "ping @maintainers and [click](https://evil.test)",
      category: "security",
      body: "Rendered <img src=x> and @org/team should stay plain text.",
      evidence: "const x = 1;",
      path: "src/a.ts",
      line: 7,
      side: "RIGHT"
    });

    assert.doesNotMatch(body, /@maintainers/);
    assert.doesNotMatch(body, /@org\/team/);
    assert.match(body, /@\u200bmaintainers/);
    assert.match(body, /@\u200borg\/team/);
    assert.match(body, /\\\[click\\\]\\\(https:\/\/\u200bevil\.test\\\)/);
    assert.match(body, /&lt;img src=x&gt;/);
  } finally {
    await closeQueueClients();
  }
});

test("inline review comment rendering neutralizes attacker-controlled marker ids", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const body = __pipelineInternals.formatInlineComment({
      comment_id: "marker --> @release/team [click](https://evil.test)",
      severity: "important",
      title: "Marker breakout",
      category: "security",
      body: "Hidden marker ids must stay inert.",
      evidence: "const x = 1;",
      path: "src/a.ts",
      line: 8,
      side: "RIGHT"
    });

    assert.doesNotMatch(body, /@release\/team/);
    assert.doesNotMatch(body, /\[click\]\(https:\/\/evil\.test\)/);
    assert.match(body, /^<!-- grepiku:[A-Za-z0-9._-]+ -->/);
  } finally {
    await closeQueueClients();
  }
});

test("GitHub markdown sanitization neutralizes bare autolink URLs", async () => {
  const { sanitizeGitHubMarkdownText } = await import("../src/review/githubMarkdown.js");

  const sanitized = sanitizeGitHubMarkdownText(
    "Review https://evil.test/path?q=1 before merge."
  );

  assert.doesNotMatch(sanitized, /https:\/\/evil\.test\/path\?q=1/);
  assert.match(sanitized, /https:\/\/\u200bevil\.test\/path\?q=1/);
});

test("inline suggested patches keep attacker-controlled fence text inside the suggestion block", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const body = __pipelineInternals.formatInlineComment({
      comment_id: "c2",
      severity: "important",
      title: "Fence breakout",
      category: "security",
      body: "Keep the suggested patch inside one fenced block.",
      evidence: "const x = 1;",
      suggested_patch: 'const safe = true;\n```\n@ops/team [click](https://evil.test)',
      path: "src/a.ts",
      line: 9,
      side: "RIGHT"
    });

    assert.match(body, /````suggestion/);
    assert.match(body, /\nconst safe = true;\n```\n@ops\/team \[click\]\(https:\/\/evil\.test\)\n````$/);
  } finally {
    await closeQueueClients();
  }
});

test("summary diagrams keep attacker-controlled fence text inside the mermaid block", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const block = __pipelineInternals.buildSummaryBlock(
      {
        overview: "overview",
        risk: "low",
        key_concerns: [],
        what_to_test: [],
        file_breakdown: [],
        diagram_mermaid: "graph TD\nA-->B\n```\n@click",
      },
      [],
      [],
      []
    );

    assert.match(block, /````mermaid/);
    assert.match(block, /\ngraph TD\nA-->B\n```\n@click\n````\n<\/details>\n<!-- grepiku-summary:end -->$/);
  } finally {
    await closeQueueClients();
  }
});

test("summary block keeps large-review details collapsed behind concise headings", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const block = __pipelineInternals.buildSummaryBlock(
      {
        overview:
          "Large PR reviewed in 7 chunks across 149 files. Highest-risk areas: docker-compose.yml, Dockerfile, src/review/pipeline.ts. Top findings: git metadata check rejects normal .git directories; chunked reviewer output is too verbose.",
        risk: "high",
        confidence: 0.82,
        key_concerns: ["git metadata check rejects .git directories", "summary is too verbose"],
        what_to_test: ["open a PR with >100 files", "verify the PR body stays compact"],
        file_breakdown: [
          { path: "docker-compose.yml", summary: "infra changes", risk: "high" },
          { path: "Dockerfile", summary: "runtime changes", risk: "high" }
        ]
      },
      [
        {
          comment_id: "c1",
          comment_key: "c1",
          path: "src/review/pipeline.ts",
          side: "RIGHT",
          line: 10,
          severity: "blocking",
          category: "bug",
          title: "Git metadata check rejects normal .git directories",
          body: "details",
          evidence: "evidence",
          suggested_patch: "fix();",
          comment_type: "summary",
          confidence: "high"
        }
      ],
      [],
      []
    );

    assert.match(block, /## Grepiku Summary/);
    assert.match(block, /### Top Findings/);
    assert.match(block, /### What to Test/);
    assert.match(block, /<summary>Fix with AI<\/summary>/);
    assert.match(block, /<summary>Review details<\/summary>/);
    assert.doesNotMatch(block, /Risk: high  /);
  } finally {
    await closeQueueClients();
  }
});

test("mention PR body rendering neutralizes task text, summaries, and file names", async () => {
  ensureReviewRenderTestEnv();
  const { __mentionInternals } = await import("../src/review/mentions.js");
  try {
    const body = __mentionInternals.renderPrBody({
      summary: "Asked @release/team to merge [this](https://evil.test).",
      prBodyHint: "See <script>alert(1)</script>",
      task: "Update src/[boom](@team).ts and notify @release/team",
      commentUrl: "https://github.com/acme/repo/pull/1#issuecomment-1",
      changedFiles: ["src/[boom](@team).ts"],
      checks: {
        checks: {
          lint: { status: "pass", summary: "ok", top_errors: [] },
          build: { status: "pass", summary: "ok", top_errors: [] },
          test: { status: "pass", summary: "ok", top_errors: [] }
        }
      }
    });

    assert.doesNotMatch(body, /@release\/team/);
    assert.doesNotMatch(body, /@team/);
    assert.match(body, /@\u200brelease\/team/);
    assert.match(body, /@\u200bteam/);
    assert.match(body, /\\\[this\\\]\\\(https:\/\/\u200bevil\.test\\\)/);
    assert.match(body, /&lt;script&gt;alert\\\(1\\\)&lt;\/script&gt;/);
  } finally {
    await closeQueueClients();
  }
});

test("mention PR body rendering neutralizes GitHub issue-closing references", async () => {
  ensureReviewRenderTestEnv();
  const { __mentionInternals } = await import("../src/review/mentions.js");
  try {
    const body = __mentionInternals.renderPrBody({
      summary: "Fixes #12, resolves acme/repo#34, and closes https://github.com/acme/repo/issues/56.",
      prBodyHint: "See details in #78.",
      task: "Avoid auto-closing issue #90",
      commentUrl: "https://github.com/acme/repo/pull/1#issuecomment-1",
      changedFiles: ["src/example.ts"],
      checks: {
        checks: {
          lint: { status: "pass", summary: "ok", top_errors: [] },
          build: { status: "pass", summary: "ok", top_errors: [] },
          test: { status: "pass", summary: "ok", top_errors: [] }
        }
      }
    });

    assert.doesNotMatch(body, /\bFixes #12\b/);
    assert.doesNotMatch(body, /\bresolves acme\/repo#34\b/i);
    assert.doesNotMatch(body, /\bcloses https:\/\/github\.com\/acme\/repo\/issues\/56\b/i);
    assert.match(body, /F\u200bixes #\u200b12/);
    assert.match(body, /r\u200besolves acme\/repo#\u200b34/);
    assert.match(body, /c\u200bloses https:\/\/\u200bgithub\.com\/acme\/repo\/issues\/56/);
    assert.match(body, /#\u200b78/);
    assert.match(body, /#\u200b90/);
  } finally {
    await closeQueueClients();
  }
});

test("mention follow-up PR metadata neutralizes mentions and issue-closing references", async () => {
  ensureReviewRenderTestEnv();
  const { __mentionInternals } = await import("../src/review/mentions.js");
  try {
    assert.equal(typeof __mentionInternals.sanitizeCommitMessage, "function");
    assert.equal(typeof __mentionInternals.sanitizePrTitle, "function");

    const commitMessage = __mentionInternals.sanitizeCommitMessage(
      "Fixes #12\nPing @release/team",
      "Fixes #90 for @release/team"
    );
    const prTitle = __mentionInternals.sanitizePrTitle(
      "Fixes #34\n@release/team follow-up",
      "Fixes #56 for @release/team"
    );
    const fallbackCommitMessage = __mentionInternals.sanitizeCommitMessage(
      undefined,
      "Fixes #78 for @release/team"
    );
    const fallbackPrTitle = __mentionInternals.sanitizePrTitle(
      undefined,
      "Fixes #91 for @release/team"
    );

    assert.doesNotMatch(commitMessage, /\bFixes #12\b/);
    assert.doesNotMatch(commitMessage, /@release\/team/);
    assert.match(commitMessage, /F\u200bixes #\u200b12/);
    assert.match(commitMessage, /@\u200brelease\/team/);

    assert.doesNotMatch(prTitle, /\bFixes #34\b/);
    assert.doesNotMatch(prTitle, /@release\/team/);
    assert.match(prTitle, /F\u200bixes #\u200b34/);
    assert.match(prTitle, /@\u200brelease\/team/);
    assert.doesNotMatch(prTitle, /\n/);

    assert.doesNotMatch(fallbackCommitMessage, /\bFixes #78\b/);
    assert.doesNotMatch(fallbackCommitMessage, /@release\/team/);
    assert.match(fallbackCommitMessage, /#\u200b78/);
    assert.match(fallbackCommitMessage, /@\u200brelease\/team/);

    assert.doesNotMatch(fallbackPrTitle, /\bFixes #91\b/);
    assert.doesNotMatch(fallbackPrTitle, /@release\/team/);
    assert.match(fallbackPrTitle, /#\u200b91/);
    assert.match(fallbackPrTitle, /@\u200brelease\/team/);
  } finally {
    await closeQueueClients();
  }
});
