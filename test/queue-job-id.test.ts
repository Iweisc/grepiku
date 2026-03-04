import test from "node:test";
import assert from "node:assert/strict";
import { buildIndexJobId, buildReviewJobId } from "../src/queue/jobId.js";

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

test("buildReviewJobId is deterministic across non-force triggers", () => {
  const first = buildReviewJobId({
    repoId: "acme/repo",
    pullRequestId: 77,
    headSha: "deadbeef1234",
    trigger: "opened"
  });
  const second = buildReviewJobId({
    repoId: "acme/repo",
    pullRequestId: 77,
    headSha: "deadbeef1234",
    trigger: "synchronize"
  });

  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.ok(first.endsWith("_auto"));
});

test("buildReviewJobId changes by SHA and mode", () => {
  const autoJob = buildReviewJobId({
    repoId: 1,
    pullRequestId: 2,
    headSha: "aaa111"
  });
  const differentSha = buildReviewJobId({
    repoId: 1,
    pullRequestId: 2,
    headSha: "bbb222"
  });
  const forceJob = buildReviewJobId({
    repoId: 1,
    pullRequestId: 2,
    headSha: "aaa111",
    force: true
  });

  assert.notEqual(autoJob, differentSha);
  assert.ok(forceJob.endsWith("_force"));
});
