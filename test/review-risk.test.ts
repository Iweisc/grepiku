import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChangedFileRisk,
  isHighImpactReviewPath,
  isStatefulReviewPath
} from "../src/review/risk.js";

test("classifyChangedFileRisk promotes low-churn conversation service files", () => {
  assert.equal(
    classifyChangedFileRisk({
      path: "apps/be-ai-assistant/src/chat/services/conversation_service.go",
      additions: 4,
      deletions: 1
    }),
    "high"
  );
  assert.equal(isStatefulReviewPath("apps/be-ai-assistant/src/chat/services/conversation_service.go"), true);
});

test("classifyChangedFileRisk promotes auth-sensitive files to high risk", () => {
  assert.equal(
    classifyChangedFileRisk({
      path: "apps/be-common/middleware/jwt_auth.go",
      additions: 1,
      deletions: 0
    }),
    "high"
  );
  assert.equal(isHighImpactReviewPath("apps/be-common/middleware/jwt_auth.go"), true);
});

test("classifyChangedFileRisk promotes conversation models and migrations", () => {
  assert.equal(
    classifyChangedFileRisk({
      path: "apps/be-common/models/conversation_model.go",
      additions: 3,
      deletions: 0
    }),
    "high"
  );
  assert.equal(
    classifyChangedFileRisk({
      path: "apps/be-database/db/migrations/000045_scope_conversation_threads_by_user.up.sql",
      additions: 9,
      deletions: 0
    }),
    "high"
  );
});

test("classifyChangedFileRisk promotes browser queues", () => {
  const path = "packages/web-script/src/backend/opfs-queue.ts";
  assert.equal(
    classifyChangedFileRisk({
      path,
      additions: 2,
      deletions: 0
    }),
    "high"
  );
  assert.equal(isHighImpactReviewPath(path), true);
});

test("classifyChangedFileRisk promotes security-sensitive infra and extension files", () => {
  for (const path of [
    "apps/be-database/patroni/pgbouncer.ini",
    "apps/be-database/patroni/patroni.yml",
    "apps/be-notification/deployment/rabbitmq/rabbitmq.conf",
    "apps/user-dashboard/e2e/.auth/state.json",
    "apps/chrome-extension/src/background/background.ts",
    "apps/qa-extension/src/content/content.ts"
  ]) {
    assert.equal(
      classifyChangedFileRisk({
        path,
        additions: 1,
        deletions: 0
      }),
      "high"
    );
    assert.equal(isHighImpactReviewPath(path), true);
  }
});
