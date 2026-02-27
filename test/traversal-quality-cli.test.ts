import test from "node:test";
import assert from "node:assert/strict";
import { __traversalQualityInternals } from "../src/tools/traversalQuality.js";

test("parseArgs ignores invalid numeric values for limit/since-days/concurrency", () => {
  const options = __traversalQualityInternals.parseArgs([
    "--limit=wat",
    "--since-days=oops",
    "--concurrency=nan"
  ]);

  assert.equal(options.limit, 400);
  assert.equal(options.sinceDays, undefined);
  assert.equal(options.concurrency, 4);
});

test("parseArgs clamps valid numeric values", () => {
  const options = __traversalQualityInternals.parseArgs([
    "--limit=6000",
    "--since-days=0",
    "--concurrency=99"
  ]);

  assert.equal(options.limit, 5000);
  assert.equal(options.sinceDays, 1);
  assert.equal(options.concurrency, 16);
});
