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

test("blocking summary findings still count as blocking review output", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    assert.equal(
      __pipelineInternals.hasBlockingVisibleFindings({
        inline: [],
        summary: [
          {
            severity: "blocking"
          }
        ]
      }),
      true
    );
  } finally {
    await closeQueueClients();
  }
});

test("non-blocking visible findings do not trip blocking review state", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    assert.equal(
      __pipelineInternals.hasBlockingVisibleFindings({
        inline: [
          {
            severity: "important"
          }
        ],
        summary: [
          {
            severity: "nit"
          }
        ]
      }),
      false
    );
  } finally {
    await closeQueueClients();
  }
});

test("required status checks fail closed when verifier tools fail", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const conclusion = (__pipelineInternals as any).resolveStatusCheckConclusion({
      required: true,
      inline: [],
      summary: [],
      checks: {
        lint: { status: "fail", summary: "exited with 1", top_errors: [] },
        build: { status: "pass", summary: "success", top_errors: [] },
        test: { status: "skipped", summary: "not configured", top_errors: [] }
      }
    });

    assert.equal(conclusion, "failure");
  } finally {
    await closeQueueClients();
  }
});

test("non-required status checks surface verifier failures as neutral", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const conclusion = (__pipelineInternals as any).resolveStatusCheckConclusion({
      required: false,
      inline: [],
      summary: [],
      checks: {
        lint: { status: "pass", summary: "success", top_errors: [] },
        build: { status: "error", summary: "verifier stage failed", top_errors: ["boom"] },
        test: { status: "skipped", summary: "not configured", top_errors: [] }
      }
    });

    assert.equal(conclusion, "neutral");
  } finally {
    await closeQueueClients();
  }
});

test("retrying the same auto review job recovers a stale running duplicate instead of skipping", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    assert.equal(
      (__pipelineInternals as any).shouldRecoverRunningDuplicateRun({
        duplicateRunStatus: "running",
        currentJobId: "review_1_1_deadbeef_auto",
        expectedJobId: "review_1_1_deadbeef_auto"
      }),
      true
    );
    assert.equal(
      (__pipelineInternals as any).shouldSkipDuplicateReviewRun({
        duplicateRunStatus: "running",
        currentJobId: "review_1_1_deadbeef_auto",
        expectedJobId: "review_1_1_deadbeef_auto"
      }),
      false
    );
  } finally {
    await closeQueueClients();
  }
});

test("different or completed duplicate runs are still skipped", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    assert.equal(
      (__pipelineInternals as any).shouldSkipDuplicateReviewRun({
        duplicateRunStatus: "running",
        currentJobId: "review_1_1_deadbeef_auto",
        expectedJobId: "review_1_1_cafebabe_auto"
      }),
      true
    );
    assert.equal(
      (__pipelineInternals as any).shouldSkipDuplicateReviewRun({
        duplicateRunStatus: "completed",
        currentJobId: "review_1_1_deadbeef_auto",
        expectedJobId: "review_1_1_deadbeef_auto"
      }),
      true
    );
  } finally {
    await closeQueueClients();
  }
});

test("inline comment sync ignores spoofed marker comments from non-bot authors", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const lookup = (__pipelineInternals as any).buildExistingInlineCommentLookup(
      [
        {
          id: "1",
          body: "<!-- grepiku:abc123 -->\nHuman spoofed marker comment",
          authorLogin: "outside-contributor"
        },
        {
          id: "2",
          body: "<!-- grepiku:abc123 -->\nReal bot marker comment",
          authorLogin: "grepiku-dev[bot]"
        }
      ],
      "grepiku-dev"
    );

    assert.equal(lookup.get("abc123")?.id, "2");
  } finally {
    await closeQueueClients();
  }
});


test("agentic chunk mode selector only enables configured large chunked reviews", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    assert.equal(
      (__pipelineInternals as any).shouldUseAgenticChunkReviewer({
        mode: "agentic",
        chunkCount: 2,
        totalChangedLines: 16000
      }),
      true
    );
    assert.equal(
      (__pipelineInternals as any).shouldUseAgenticChunkReviewer({
        mode: "direct",
        chunkCount: 2,
        totalChangedLines: 16000
      }),
      false
    );
    assert.equal(
      (__pipelineInternals as any).shouldUseAgenticChunkReviewer({
        mode: "agentic",
        chunkCount: 1,
        totalChangedLines: 30000
      }),
      false
    );
  } finally {
    await closeQueueClients();
  }
});

test("agentic evidence diagnostic requires evidence and tracks inspected files when available", async () => {
  ensureReviewRenderTestEnv();
  const { __pipelineInternals } = await import("../src/review/pipeline.js");
  try {
    const review = {
      summary: { overview: "", risk: "low", confidence: 1, key_concerns: [], what_to_test: [], file_breakdown: [] },
      comments: [
        {
          comment_id: "c1",
          comment_key: "c1",
          path: "src/app.ts",
          side: "RIGHT",
          line: 1,
          severity: "important",
          category: "bug",
          title: "Bug",
          body: "Body",
          evidence: "+broken",
          confidence: "high"
        }
      ]
    };
    assert.equal((__pipelineInternals as any).reviewHasInspectedEvidence(review, ["src/app.ts"]), true);
    assert.equal((__pipelineInternals as any).reviewHasInspectedEvidence(review, ["src/other.ts"]), false);
  } finally {
    await closeQueueClients();
  }
});
