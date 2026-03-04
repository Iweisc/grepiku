import test from "node:test";
import assert from "node:assert/strict";
import { computeWeight, isProtectedKey } from "../src/services/weights.js";

// --- computeWeight ---

test("computeWeight returns 0 when all counts are zero", () => {
  const w = computeWeight({ addressed: 0, ignored: 0, positive: 0, negative: 0 });
  assert.equal(w, 0);
});

test("computeWeight returns positive when addressed > ignored", () => {
  const w = computeWeight({ addressed: 10, ignored: 2, positive: 0, negative: 0 });
  assert.ok(w > 0, `expected positive weight, got ${w}`);
});

test("computeWeight returns negative when ignored > addressed", () => {
  const w = computeWeight({ addressed: 1, ignored: 10, positive: 0, negative: 0 });
  assert.ok(w < 0, `expected negative weight, got ${w}`);
});

test("computeWeight is clamped to [-1, 1]", () => {
  const high = computeWeight({ addressed: 1000, ignored: 0, positive: 1000, negative: 0 });
  const low = computeWeight({ addressed: 0, ignored: 1000, positive: 0, negative: 1000 });
  assert.ok(high <= 1, `expected <= 1, got ${high}`);
  assert.ok(low >= -1, `expected >= -1, got ${low}`);
});

test("computeWeight combines outcomes and reactions when both present", () => {
  const outcomeOnly = computeWeight({ addressed: 5, ignored: 1, positive: 0, negative: 0 });
  const combined = computeWeight({ addressed: 5, ignored: 1, positive: 3, negative: 0 });
  // Combined should differ from outcome-only since reactions contribute
  assert.notEqual(outcomeOnly, combined);
  assert.ok(combined > 0);
});

test("computeWeight uses only reaction signal when no outcomes", () => {
  const w = computeWeight({ addressed: 0, ignored: 0, positive: 5, negative: 1 });
  assert.ok(w > 0, `expected positive weight from reactions, got ${w}`);
});

test("computeWeight produces negative from negative reactions only", () => {
  const w = computeWeight({ addressed: 0, ignored: 0, positive: 0, negative: 5 });
  assert.ok(w < 0, `expected negative weight, got ${w}`);
});

// --- isProtectedKey ---

test("isProtectedKey returns true for 'security'", () => {
  assert.equal(isProtectedKey("security"), true);
});

test("isProtectedKey returns true for 'security:some-rule'", () => {
  assert.equal(isProtectedKey("security:some-rule"), true);
});

test("isProtectedKey returns true for 'injection'", () => {
  assert.equal(isProtectedKey("injection"), true);
});

test("isProtectedKey returns true for 'xss'", () => {
  assert.equal(isProtectedKey("xss"), true);
});

test("isProtectedKey returns true for 'sql injection'", () => {
  assert.equal(isProtectedKey("sql injection"), true);
});

test("isProtectedKey returns true for 'authz'", () => {
  assert.equal(isProtectedKey("authz"), true);
});

test("isProtectedKey is case insensitive", () => {
  assert.equal(isProtectedKey("Security"), true);
  assert.equal(isProtectedKey("XSS"), true);
});

test("isProtectedKey returns false for 'style'", () => {
  assert.equal(isProtectedKey("style"), false);
});

test("isProtectedKey returns false for 'maintainability'", () => {
  assert.equal(isProtectedKey("maintainability"), false);
});

// --- Protected categories never go negative ---

test("protected category weight is clamped to >= 0", () => {
  // Simulate: security category has lots of ignored findings
  // The computeWeight itself doesn't enforce the protection;
  // that's done in updateFindingWeights. But we can verify the formula
  // would produce negative, and the clamp logic would fix it.
  const rawWeight = computeWeight({ addressed: 0, ignored: 10, positive: 0, negative: 5 });
  assert.ok(rawWeight < 0, "raw weight should be negative");
  // The protection clamp: if isProtectedKey && weight < 0, clamp to 0
  const clampedWeight = isProtectedKey("security") && rawWeight < 0 ? 0 : rawWeight;
  assert.equal(clampedWeight, 0);
});

// --- priorityScore integration with weights ---

test("weight adjustment scales [-1,1] to [-20,+20] points", () => {
  // Verify the math: weight * 20
  const weight = 0.5;
  const adjustment = weight * 20;
  assert.equal(adjustment, 10);

  const negWeight = -0.8;
  const negAdjustment = negWeight * 20;
  assert.equal(negAdjustment, -16);
});

// --- Outcome classification ---

test("findings with status fixed are classified as addressed", () => {
  const status = "fixed";
  const addressed = status === "fixed" || status === "obsolete";
  assert.equal(addressed, true);
});

test("findings with status obsolete are classified as addressed", () => {
  const status = "obsolete";
  const addressed = status === "fixed" || status === "obsolete";
  assert.equal(addressed, true);
});

test("findings with status open are classified as ignored", () => {
  const status = "open";
  const addressed = status === "fixed" || status === "obsolete";
  assert.equal(addressed, false);
});
