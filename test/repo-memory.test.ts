import assert from "node:assert/strict";
import test from "node:test";
import { extractRepoMemoryInstruction, mergeRulesWithRepoMemory } from "../src/services/repoMemory.js";
import type { RuleConfig } from "../src/review/config.js";

test("extractRepoMemoryInstruction captures directive preference text", () => {
  const value = extractRepoMemoryInstruction("don't use fetch inside useEffect for data loading");
  assert.equal(value, "don't use fetch inside useEffect for data loading");
});

test("extractRepoMemoryInstruction ignores questions and non-directives", () => {
  assert.equal(extractRepoMemoryInstruction("can we avoid this approach?"), null);
  assert.equal(extractRepoMemoryInstruction("looks good to me"), null);
});

test("mergeRulesWithRepoMemory appends learned rules without duplicating ids", () => {
  const base: RuleConfig[] = [
    { id: "r1", title: "Base rule 1" },
    { id: "r2", title: "Base rule 2" }
  ];
  const memory: RuleConfig[] = [
    { id: "r2", title: "duplicate" },
    { id: "memory-a", title: "Learned preference" }
  ];

  const merged = mergeRulesWithRepoMemory(base, memory);
  assert.deepEqual(merged.map((item) => item.id), ["r1", "r2", "memory-a"]);
});
