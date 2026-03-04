import test from "node:test";
import assert from "node:assert/strict";
import { selectFixedFindingCandidates } from "../src/review/findingLifecycle.js";

function finding(overrides: Partial<{
  id: number;
  path: string;
  category: string;
  title: string;
  reviewRunId: number;
  lastSeenRunId: number | null;
}> = {}) {
  return {
    id: 1,
    path: "src/main.ts",
    category: "correctness",
    title: "Null-check missing on optional config path",
    reviewRunId: 12,
    lastSeenRunId: 12 as number | null,
    ...overrides
  };
}

test("same-SHA reruns do not auto-mark findings as fixed", () => {
  const fixed = selectFixedFindingCandidates({
    existingOpen: [finding()],
    matchedOldIds: new Set<number>(),
    incomingSemanticKeys: new Set<string>(),
    incrementalReview: false,
    changedPathSet: new Set<string>(["src/main.ts"]),
    currentHeadSha: "abc123",
    headShaByRunId: new Map<number, string>([[12, "abc123"]])
  });

  assert.equal(fixed.length, 0);
});

test("incremental mode only fixes unmatched findings on changed paths", () => {
  const fixed = selectFixedFindingCandidates({
    existingOpen: [
      finding({ id: 1, path: "src/main.ts", reviewRunId: 12, lastSeenRunId: 12 }),
      finding({ id: 2, path: "src/other.ts", reviewRunId: 12, lastSeenRunId: 12 })
    ],
    matchedOldIds: new Set<number>(),
    incomingSemanticKeys: new Set<string>(),
    incrementalReview: true,
    changedPathSet: new Set<string>(["src/main.ts"]),
    currentHeadSha: "def456",
    headShaByRunId: new Map<number, string>([[12, "abc123"]])
  });

  assert.deepEqual(fixed.map((item) => item.id), [1]);
});

test("non-incremental mode fixes unmatched findings from older SHAs", () => {
  const fixed = selectFixedFindingCandidates({
    existingOpen: [finding({ id: 5, path: "src/stale.ts", reviewRunId: 9, lastSeenRunId: 9 })],
    matchedOldIds: new Set<number>(),
    incomingSemanticKeys: new Set<string>(),
    incrementalReview: false,
    changedPathSet: new Set<string>(),
    currentHeadSha: "new-sha",
    headShaByRunId: new Map<number, string>([[9, "old-sha"]])
  });

  assert.deepEqual(fixed.map((item) => item.id), [5]);
});
