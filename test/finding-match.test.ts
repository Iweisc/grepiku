import test from "node:test";
import assert from "node:assert/strict";
import { selectSemanticFindingCandidate, type ExistingFindingCandidate } from "../src/review/findingMatch.js";
import type { ReviewComment } from "../src/review/schemas.js";

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    comment_id: "c1",
    comment_key: "c1",
    path: "src/runner/codexRunner.ts",
    side: "RIGHT",
    line: 238,
    severity: "important",
    category: "maintainability",
    title: "Unique worktree allocation no longer prunes stale same-SHA worktrees",
    body: "Stale same-SHA worktrees are left behind after retries.",
    evidence: "worktree prepare call no longer removes old same-SHA directory",
    suggested_patch: "add stale worktree cleanup before allocation",
    comment_type: "inline",
    confidence: "high",
    ...overrides
  };
}

function makeCandidate(overrides: Partial<ExistingFindingCandidate> = {}): ExistingFindingCandidate {
  return {
    id: 1,
    path: "src/runner/codexRunner.ts",
    line: 236,
    side: "RIGHT",
    severity: "important",
    category: "maintainability",
    title: "Unique worktree allocation has no stale-worktree cleanup",
    body: "Old worktrees for the same SHA are not cleaned up.",
    ...overrides
  };
}

test("selects semantic match for same issue with reworded title", () => {
  const result = selectSemanticFindingCandidate({
    comment: makeComment(),
    candidates: [
      makeCandidate(),
      makeCandidate({
        id: 2,
        line: 410,
        title: "Status check updates may fail with missing permissions",
        body: "Check-run writes are forbidden and should fallback cleanly."
      })
    ]
  });

  assert.ok(result);
  assert.equal(result?.id, 1);
});

test("does not match unrelated issue in same file/category", () => {
  const result = selectSemanticFindingCandidate({
    comment: makeComment({
      title: "Per-path cap can return fewer results than topK",
      body: "Retriever returns less than requested topK due to per-file cap.",
      line: 74,
      category: "performance"
    }),
    candidates: [
      makeCandidate({
        id: 3,
        line: 310,
        category: "performance",
        title: "Runtime cache key collisions can return stale retrieval results",
        body: "Current cache key omits branch identity."
      })
    ]
  });

  assert.equal(result, undefined);
});

test("skips candidates already matched in this run", () => {
  const result = selectSemanticFindingCandidate({
    comment: makeComment(),
    candidates: [makeCandidate({ id: 7 })],
    matchedIds: new Set([7])
  });

  assert.equal(result, undefined);
});
