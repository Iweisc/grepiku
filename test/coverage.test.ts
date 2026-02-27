import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCoveragePlan,
  mergeSupplementalComments,
  mergeSupplementalSummary
} from "../src/review/coverage.js";
import type { ReviewComment } from "../src/review/schemas.js";

function makeComment(params: {
  id: string;
  path: string;
  line: number;
  title: string;
  severity?: ReviewComment["severity"];
  category?: ReviewComment["category"];
  confidence?: ReviewComment["confidence"];
}): ReviewComment {
  return {
    comment_id: params.id,
    comment_key: params.id,
    path: params.path,
    side: "RIGHT",
    line: params.line,
    severity: params.severity || "important",
    category: params.category || "bug",
    title: params.title,
    body: "details",
    evidence: "evidence",
    suggested_patch: "const x = 1;",
    comment_type: "inline",
    confidence: params.confidence || "high"
  };
}

test("buildCoveragePlan prioritizes uncovered high-risk changed files", () => {
  const plan = buildCoveragePlan({
    changedFiles: [
      { path: "src/a.ts", additions: 180, deletions: 90 },
      { path: "src/b.ts", additions: 10, deletions: 2 },
      { path: "src/c.ts", additions: 8, deletions: 1 }
    ],
    changedFileStats: [
      { path: "src/a.ts", risk: "high", additions: 180, deletions: 90 },
      { path: "src/b.ts", risk: "low", additions: 10, deletions: 2 },
      { path: "src/c.ts", risk: "low", additions: 8, deletions: 1 }
    ],
    comments: [makeComment({ id: "b1", path: "src/b.ts", line: 12, title: "Issue in b" })]
  });

  assert.equal(plan.shouldRun, true);
  assert.equal(plan.stats.totalChanged, 3);
  assert.equal(plan.stats.coveredChanged, 1);
  assert.equal(plan.stats.uncoveredChanged, 2);
  assert.equal(plan.targets[0]?.path, "src/a.ts");
});

test("mergeSupplementalComments skips semantic duplicates and keeps net-new issues", () => {
  const base = [makeComment({ id: "a1", path: "src/a.ts", line: 22, title: "Missing null check" })];
  const supplemental = [
    makeComment({ id: "a2", path: "src/a.ts", line: 24, title: "Missing null check!" }),
    makeComment({ id: "a3", path: "src/a.ts", line: 41, title: "Retry loop can spin forever" })
  ];

  const merged = mergeSupplementalComments({ base, supplemental });
  assert.equal(merged.comments.length, 2);
  assert.equal(merged.added, 1);
  assert.equal(merged.droppedDuplicates, 1);
});

test("mergeSupplementalSummary promotes higher risk and keeps conservative confidence", () => {
  const summary = mergeSupplementalSummary({
    base: {
      overview: "base",
      risk: "low",
      confidence: 0.9,
      key_concerns: ["base concern"],
      what_to_test: ["base test"],
      file_breakdown: [{ path: "src/a.ts", summary: "base summary", risk: "low" }]
    },
    supplemental: {
      overview: "supplemental",
      risk: "high",
      confidence: 0.6,
      key_concerns: ["extra concern"],
      what_to_test: ["extra test"],
      file_breakdown: [{ path: "src/b.ts", summary: "extra summary", risk: "high" }]
    },
    maxKeyConcerns: 5
  });

  assert.equal(summary.risk, "high");
  assert.equal(summary.confidence, 0.6);
  assert.equal(summary.key_concerns.length, 2);
  assert.equal(summary.file_breakdown?.length, 2);
});
