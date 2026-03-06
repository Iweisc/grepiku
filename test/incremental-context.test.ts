import assert from "node:assert/strict";
import test from "node:test";
import { buildIncrementalReviewContext } from "../src/review/incrementalContext.js";

test("buildIncrementalReviewContext returns null without previous run", () => {
  const context = buildIncrementalReviewContext({
    previousRun: null,
    openFindings: []
  });

  assert.equal(context, null);
});

test("buildIncrementalReviewContext carries prior summary and open findings", () => {
  const context = buildIncrementalReviewContext({
    previousRun: {
      id: 7,
      headSha: "abc123",
      trigger: "synchronize",
      completedAt: new Date("2026-03-05T10:00:00.000Z"),
      summaryJson: {
        overview: "fallback summary",
        risk: "medium",
        key_concerns: [],
        what_to_test: []
      },
      finalJson: {
        summary: {
          overview: "Whole PR adds API and docs changes.",
          risk: "medium",
          key_concerns: ["API surface changed"],
          what_to_test: ["Custom tag flow"],
          file_breakdown: [{ path: "src/api.ts", summary: "Adds endpoint", risk: "medium" }]
        },
        comments: [
          {
            comment_id: "c1",
            comment_key: "k1",
            path: "src/api.ts",
            side: "RIGHT",
            line: 12,
            severity: "important",
            category: "bug",
            title: "Validate metadata shape",
            body: "Missing validation on metadata payload.",
            evidence: "payload is forwarded unchecked",
            comment_type: "summary",
            confidence: "high"
          }
        ]
      }
    },
    openFindings: [
      {
        path: "src/docs.ts",
        line: 40,
        severity: "nit",
        category: "style",
        title: "Docs wording drift",
        body: "Documentation overstates behavior."
      },
      {
        path: "src/api.ts",
        line: 12,
        severity: "blocking",
        category: "bug",
        title: "Validate metadata shape",
        body: "Missing validation on metadata payload.",
        ruleId: "api-contract",
        ruleReason: "Public API accepts unvalidated input"
      }
    ]
  });

  assert.ok(context);
  assert.equal(context.previous_run.summary?.overview, "Whole PR adds API and docs changes.");
  assert.equal(context.previous_run.comments[0]?.title, "Validate metadata shape");
  assert.equal(context.carried_open_findings[0]?.severity, "blocking");
  assert.equal(context.carried_open_findings[0]?.rule_id, "api-contract");
});

test("buildIncrementalReviewContext falls back to summaryJson when finalJson is invalid", () => {
  const context = buildIncrementalReviewContext({
    previousRun: {
      id: 8,
      headSha: "def456",
      trigger: "opened",
      completedAt: null,
      finalJson: { not: "a review" },
      summaryJson: {
        overview: "Fallback whole-PR summary.",
        risk: "low",
        key_concerns: [],
        what_to_test: []
      }
    },
    openFindings: []
  });

  assert.ok(context);
  assert.equal(context.previous_run.summary?.overview, "Fallback whole-PR summary.");
  assert.deepEqual(context.previous_run.comments, []);
});
