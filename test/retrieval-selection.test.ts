import assert from "node:assert/strict";
import test from "node:test";
import { selectRankedRetrievalItems } from "../src/services/retrieval.js";

type Item = {
  embedding: { id: number };
  path?: string;
  score: number;
};

test("selection backfills overflow to reach topK when per-path cap is hit", () => {
  const scored: Item[] = [
    { embedding: { id: 1 }, path: "a.ts", score: 100 },
    { embedding: { id: 2 }, path: "a.ts", score: 99 },
    { embedding: { id: 3 }, path: "a.ts", score: 98 },
    { embedding: { id: 4 }, path: "a.ts", score: 97 },
    { embedding: { id: 5 }, path: "a.ts", score: 96 },
    { embedding: { id: 6 }, path: "b.ts", score: 95 },
    { embedding: { id: 7 }, path: "b.ts", score: 94 },
    { embedding: { id: 8 }, path: "b.ts", score: 93 }
  ];

  const selected = selectRankedRetrievalItems({
    scored,
    topK: 6,
    maxPerPath: 2,
    changedPaths: new Set<string>()
  });

  assert.equal(selected.length, 6);
  const ids = new Set(selected.map((item) => item.embedding.id));
  assert.equal(ids.size, 6);
});

test("selection anchors changed paths before diversity and backfill passes", () => {
  const scored: Item[] = [
    { embedding: { id: 1 }, path: "core/a.ts", score: 100 },
    { embedding: { id: 2 }, path: "core/b.ts", score: 99 },
    { embedding: { id: 3 }, path: "changed/target.ts", score: 40 },
    { embedding: { id: 4 }, path: "core/c.ts", score: 98 },
    { embedding: { id: 5 }, path: "core/d.ts", score: 97 }
  ];

  const selected = selectRankedRetrievalItems({
    scored,
    topK: 4,
    maxPerPath: 1,
    changedPaths: new Set(["changed/target.ts"])
  });

  assert.equal(selected.length, 4);
  assert.ok(selected.some((item) => item.path === "changed/target.ts"));
});
