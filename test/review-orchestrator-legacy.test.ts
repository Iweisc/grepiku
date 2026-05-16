import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("review worker does not forward legacy comment-reply jobs into the mention queue", async () => {
  const script = await fs.readFile(
    new URL("../src/workers/review-orchestrator.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(script, /\benqueueCommentReplyJob\b/);
  assert.doesNotMatch(script, /legacy comment-reply job .*forwarding to mention queue/i);
  assert.match(script, /job\.name\s*!==\s*"review"/);
  assert.match(script, /lockDuration\s*:\s*reviewWorkerLockDurationMs/);
  assert.match(script, /REVIEW_WORKER_CONCURRENCY/);
});
