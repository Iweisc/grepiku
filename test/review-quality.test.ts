import test from "node:test";
import assert from "node:assert/strict";
import { buildDiffIndex } from "../src/review/diff.js";
import { refineReviewComments } from "../src/review/quality.js";
import type { ReviewComment } from "../src/review/schemas.js";

const patch = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,4 @@
 export const a = 1;
+export const b = a + 1;
+export const c = b + 1;
 export const d = c + 1;
`;

const diffIndex = buildDiffIndex(patch);

function makeComment(params: {
  id: string;
  line: number;
  title: string;
  severity?: ReviewComment["severity"];
  suggested_patch?: string;
}): ReviewComment {
  return {
    comment_id: params.id,
    comment_key: params.id,
    path: "src/foo.ts",
    side: "RIGHT",
    line: params.line,
    severity: params.severity || "important",
    category: "bug",
    title: params.title,
    body: "Issue details",
    evidence: "Quoted evidence",
    suggested_patch: params.suggested_patch,
    comment_type: "inline",
    confidence: "high"
  };
}

test("summaryOnly keeps findings instead of dropping them by inline per-file cap", () => {
  const comments = [
    makeComment({ id: "c1", line: 1, title: "Issue 1", suggested_patch: "const x = 1;" }),
    makeComment({ id: "c2", line: 2, title: "Issue 2", suggested_patch: "const x = 2;" }),
    makeComment({ id: "c3", line: 3, title: "Issue 3", suggested_patch: "const x = 3;" }),
    makeComment({ id: "c4", line: 4, title: "Issue 4", suggested_patch: "const x = 4;" })
  ];

  const refined = refineReviewComments({
    comments,
    diffIndex,
    changedFiles: [{ path: "src/foo.ts" }],
    maxInlineComments: 3,
    summaryOnly: true,
    allowedTypes: ["summary"]
  });

  assert.equal(refined.comments.length, 4);
  for (const comment of refined.comments) {
    assert.equal(comment.comment_type, "summary");
  }
  assert.equal(refined.diagnostics.droppedPerFileCap, 0);
  assert.equal(refined.diagnostics.convertedToSummary, 4);
});

test("normal mode still applies per-file inline cap", () => {
  const comments = [
    makeComment({ id: "n1", line: 1, title: "Issue 1", suggested_patch: "const x = 1;" }),
    makeComment({ id: "n2", line: 2, title: "Issue 2", suggested_patch: "const x = 2;" }),
    makeComment({ id: "n3", line: 3, title: "Issue 3", suggested_patch: "const x = 3;" }),
    makeComment({ id: "n4", line: 4, title: "Issue 4", suggested_patch: "const x = 4;" })
  ];

  const refined = refineReviewComments({
    comments,
    diffIndex,
    changedFiles: [{ path: "src/foo.ts" }],
    maxInlineComments: 3,
    summaryOnly: false,
    allowedTypes: ["inline", "summary"]
  });

  assert.equal(refined.comments.length, 3);
  for (const comment of refined.comments) {
    assert.equal(comment.comment_type, "inline");
  }
  assert.equal(refined.diagnostics.droppedPerFileCap, 1);
});

test("blocking finding without patch is downgraded", () => {
  const refined = refineReviewComments({
    comments: [
      makeComment({
        id: "b1",
        line: 2,
        title: "Blocking without fix",
        severity: "blocking",
        suggested_patch: undefined
      })
    ],
    diffIndex,
    changedFiles: [{ path: "src/foo.ts" }],
    maxInlineComments: 5,
    summaryOnly: false,
    allowedTypes: ["inline", "summary"]
  });

  assert.equal(refined.comments.length, 1);
  assert.equal(refined.comments[0].severity, "important");
  assert.equal(refined.diagnostics.downgradedBlocking, 1);
});

test("escaped newline sequences are normalized in review text fields", () => {
  const refined = refineReviewComments({
    comments: [
      {
        comment_id: "esc-1",
        comment_key: "esc-1",
        path: "src/foo.ts",
        side: "RIGHT",
        line: 2,
        severity: "important",
        category: "bug",
        title: "Issue\\nTitle",
        body: "Line 1\\nLine 2",
        evidence: "Evidence\\nQuote",
        suggested_patch: "const x = 1;",
        comment_type: "inline",
        confidence: "high"
      }
    ],
    diffIndex,
    changedFiles: [{ path: "src/foo.ts" }],
    maxInlineComments: 5,
    summaryOnly: false,
    allowedTypes: ["inline", "summary"]
  });

  assert.equal(refined.comments.length, 1);
  assert.equal(refined.comments[0].title, "Issue Title");
  assert.equal(refined.comments[0].body, "Line 1\nLine 2");
  assert.equal(refined.comments[0].evidence, "Evidence\nQuote");
  assert.equal(refined.comments[0].suggested_patch, "const x = 1;");
});
