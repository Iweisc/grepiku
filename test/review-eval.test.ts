import assert from "node:assert/strict";
import test from "node:test";
import {
  commentMatchesLabel,
  evaluateReviewCase,
  summarizeReviewEval
} from "../src/services/reviewEval.js";
import { __reviewEvalToolInternals } from "../src/tools/reviewEval.js";
import type { ReviewOutput } from "../src/review/schemas.js";

const review: ReviewOutput = {
  summary: {
    overview: "review",
    risk: "high",
    key_concerns: [],
    what_to_test: []
  },
  comments: [
    {
      comment_id: "race-1",
      comment_key: "race-1",
      path: "apps/api/src/thread_service.go",
      side: "RIGHT",
      line: 42,
      severity: "important",
      category: "bug",
      title: "Handle check-then-insert race",
      body: "Concurrent get-or-create can hit the unique key.",
      evidence: "INSERT INTO threads",
      confidence: "high"
    },
    {
      comment_id: "fp-1",
      comment_key: "fp-1",
      path: "apps/api/src/style.ts",
      side: "RIGHT",
      line: 10,
      severity: "nit",
      category: "style",
      title: "Rename variable",
      body: "style only",
      evidence: "const x = 1"
    }
  ]
};

test("commentMatchesLabel checks path, metadata, and text regexes", () => {
  assert.equal(
    commentMatchesLabel(review.comments[0]!, {
      id: "race",
      path: "apps/api/src/thread_service.go",
      severity: "important",
      category: "bug",
      textRegex: "unique key"
    }),
    true
  );
  assert.equal(
    commentMatchesLabel(review.comments[0]!, {
      id: "wrong-path",
      path: "apps/api/src/other.go",
      textRegex: "unique key"
    }),
    false
  );
});

test("evaluateReviewCase reports recall and judged false positives", () => {
  const result = evaluateReviewCase({
    case: {
      id: "case-1",
      expectedFindings: [
        {
          id: "race",
          path: "apps/api/src/thread_service.go",
          textRegex: "check-then-insert|unique key"
        },
        {
          id: "missing",
          path: "apps/api/src/missing.go",
          textRegex: "missing"
        }
      ],
      falsePositiveFindings: [
        {
          id: "style-nit",
          path: "apps/api/src/style.ts",
          category: "style",
          titleRegex: "Rename"
        }
      ]
    },
    review
  });

  assert.equal(result.expectedMatched, 1);
  assert.deepEqual(result.expectedMissed, ["missing"]);
  assert.equal(result.falsePositiveMatched, 1);
  assert.equal(result.recall, 0.5);
  assert.equal(result.judgedPrecision, 0.5);
});

test("summarizeReviewEval applies thresholds", () => {
  const summary = summarizeReviewEval({
    cases: [
      {
        id: "case-1",
        expectedCount: 2,
        expectedMatched: 1,
        expectedMissed: ["missing"],
        falsePositiveCount: 1,
        falsePositiveMatched: 1,
        falsePositiveHits: ["style-nit"],
        recall: 0.5,
        judgedPrecision: 0.5,
        expected: [],
        falsePositives: []
      }
    ],
    minRecall: 0.8,
    minJudgedPrecision: 0.8
  });

  assert.equal(summary.thresholdStatus.pass, false);
  assert.equal(summary.recall, 0.5);
  assert.equal(summary.judgedPrecision, 0.5);
  assert.equal(summary.thresholdStatus.failures.length, 2);
});

test("review eval CLI review override takes precedence over label reviewPath", () => {
  assert.equal(
    __reviewEvalToolInternals.selectReviewPathRaw("/tmp/old-review.json", "/tmp/new-review.json"),
    "/tmp/new-review.json"
  );
  assert.equal(
    __reviewEvalToolInternals.selectReviewPathRaw("/tmp/old-review.json", undefined),
    "/tmp/old-review.json"
  );
});
