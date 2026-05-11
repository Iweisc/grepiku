import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalyticsJobId,
  buildCommentReplyJobId,
  buildGraphJobId,
  buildIndexJobId,
  buildReviewJobId
} from "../src/queue/jobId.js";

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

test("buildCommentReplyJobId is deterministic and scoped to the comment target", () => {
  const first = buildCommentReplyJobId({
    provider: "github",
    pullRequestId: 77,
    commentId: "1234567890"
  });
  const second = buildCommentReplyJobId({
    provider: "github",
    pullRequestId: 77,
    commentId: "1234567890"
  });
  const differentComment = buildCommentReplyJobId({
    provider: "github",
    pullRequestId: 77,
    commentId: "9876543210"
  });

  assert.equal(first, second);
  assert.notEqual(first, differentComment);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
});

test("buildAnalyticsJobId is deterministic per review run", () => {
  const first = buildAnalyticsJobId({
    reviewRunId: 123
  });
  const second = buildAnalyticsJobId({
    reviewRunId: 123
  });
  const differentRun = buildAnalyticsJobId({
    reviewRunId: 456
  });

  assert.equal(first, second);
  assert.notEqual(first, differentRun);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
});

test("buildGraphJobId is deterministic per repository", () => {
  const first = buildGraphJobId({
    repoId: "acme/repo"
  });
  const second = buildGraphJobId({
    repoId: "acme/repo"
  });
  const differentRepo = buildGraphJobId({
    repoId: "acme/other"
  });

  assert.equal(first, second);
  assert.notEqual(first, differentRepo);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
});
