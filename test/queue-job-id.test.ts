import test from "node:test";
import assert from "node:assert/strict";
import { buildIndexJobId } from "../src/queue/jobId.js";

test("buildIndexJobId produces BullMQ-safe id characters", () => {
  const jobId = buildIndexJobId({
    repoId: "acme/repo:42",
    headSha: "abc:def/123",
    force: true
  });

  assert.match(jobId, /^[A-Za-z0-9_-]+$/);
  assert.equal(jobId.includes(":"), false);
  assert.ok(jobId.endsWith("_force"));
});

test("buildIndexJobId is deterministic and scope-sensitive", () => {
  const base = {
    repoId: 7,
    headSha: "deadbeef",
    force: false
  };
  const a = buildIndexJobId(base);
  const b = buildIndexJobId(base);
  const repoScoped = buildIndexJobId({ ...base });
  const patternScoped = buildIndexJobId({
    ...base,
    patternRepo: { url: "https://example.com/patterns.git", ref: "main" }
  });

  assert.equal(a, b);
  assert.notEqual(repoScoped, patternScoped);
  assert.ok(repoScoped.endsWith("_normal"));
});
