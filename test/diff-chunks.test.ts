import test from "node:test";
import assert from "node:assert/strict";
import {
  __diffChunkInternals,
  buildReviewDiffChunkPlan,
  mergeChunkReviewDrafts,
  type ReviewDiffChunk
} from "../src/review/diffChunks.js";
import type { ReviewOutput } from "../src/review/schemas.js";

function filePatch(path: string, additions: string[], deletions: string[] = []): string {
  const body = [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,2 @@",
    ...deletions.map((line) => `-${line}`),
    ...additions.map((line) => `+${line}`)
  ];
  return `${body.join("\n")}\n`;
}

function makeReview(id: string, risk: "low" | "medium" | "high" = "low"): ReviewOutput {
  return {
    summary: {
      overview: `overview ${id}`,
      risk,
      confidence: risk === "high" ? 0.7 : 0.9,
      key_concerns: [`concern ${id}`],
      what_to_test: [`test ${id}`],
      file_breakdown: [{ path: `src/${id}.ts`, summary: `summary ${id}`, risk }]
    },
    comments: [
      {
        comment_id: "same-id",
        comment_key: "same-key",
        path: `src/${id}.ts`,
        side: "RIGHT",
        line: 2,
        severity: "important",
        category: "bug",
        title: `issue ${id}`,
        body: "details",
        evidence: "evidence",
        suggested_patch: "fix();",
        comment_type: "inline",
        confidence: "high"
      }
    ]
  };
}

test("buildReviewDiffChunkPlan keeps file sections intact while packing by changed lines", () => {
  const diffPatch = [
    filePatch("src/a.ts", ["a1", "a2", "a3"], ["old-a"]),
    filePatch("src/b.ts", ["b1", "b2"], ["old-b"]),
    filePatch("src/c.ts", ["c1", "c2", "c3", "c4"], ["old-c"])
  ].join("");

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: [
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "src/b.ts", additions: 2, deletions: 1 },
      { path: "src/c.ts", additions: 4, deletions: 1 }
    ],
    targetChangedLines: 6
  });

  assert.equal(plan.chunks.length, 3);
  assert.deepEqual(plan.chunks.map((chunk) => chunk.paths), [
    ["src/c.ts"],
    ["src/a.ts"],
    ["src/b.ts"]
  ]);
  assert.match(plan.chunks[0]?.diffPatch || "", /diff --git a\/src\/c\.ts b\/src\/c\.ts/);
  assert.doesNotMatch(plan.chunks[0]?.diffPatch || "", /src\/a\.ts/);
});

test("buildReviewDiffChunkPlan prioritizes high-risk files before lower-risk churn", () => {
  const diffPatch = [
    filePatch("src/large.ts", ["a1", "a2", "a3", "a4", "a5"]),
    filePatch("src/security.ts", ["s1"])
  ].join("");

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: [
      { path: "src/large.ts", additions: 5, deletions: 0 },
      { path: "src/security.ts", additions: 1, deletions: 0 }
    ],
    changedFileStats: [
      { path: "src/large.ts", risk: "low", additions: 5, deletions: 0 },
      { path: "src/security.ts", risk: "high", additions: 1, deletions: 0 }
    ],
    targetChangedLines: 10
  });

  assert.equal(plan.chunks[0]?.paths[0], "src/security.ts");
});

test("buildReviewDiffChunkPlan groups same-module files before churn within a risk tier", () => {
  const diffPatch = [
    filePatch("apps/b/src/large.ts", ["b1", "b2", "b3", "b4"]),
    filePatch("apps/a/src/first.ts", ["a1"]),
    filePatch("apps/a/src/second.ts", ["a2"])
  ].join("");

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: [
      { path: "apps/b/src/large.ts", additions: 4, deletions: 0 },
      { path: "apps/a/src/first.ts", additions: 1, deletions: 0 },
      { path: "apps/a/src/second.ts", additions: 1, deletions: 0 }
    ],
    targetChangedLines: 10
  });

  assert.deepEqual(plan.chunks[0]?.paths, [
    "apps/a/src/first.ts",
    "apps/a/src/second.ts",
    "apps/b/src/large.ts"
  ]);
});

test("buildReviewDiffChunkPlan keeps chat affinity files together across modules", () => {
  const diffPatch = [
    filePatch("apps/other/src/large_auth.go", ["x1", "x2", "x3", "x4"]),
    filePatch("apps/be-ai-assistant/src/chat/services/conversation_service.go", ["s1"]),
    filePatch("apps/be-common/models/conversation_model.go", ["m1"]),
    filePatch("apps/be-database/db/migrations/000045_scope_conversation_threads_by_user.up.sql", ["i1"])
  ].join("");

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: [
      { path: "apps/other/src/large_auth.go", additions: 4, deletions: 0 },
      { path: "apps/be-ai-assistant/src/chat/services/conversation_service.go", additions: 1, deletions: 0 },
      { path: "apps/be-common/models/conversation_model.go", additions: 1, deletions: 0 },
      { path: "apps/be-database/db/migrations/000045_scope_conversation_threads_by_user.up.sql", additions: 1, deletions: 0 }
    ],
    changedFileStats: [
      { path: "apps/other/src/large_auth.go", risk: "high", additions: 4, deletions: 0 },
      {
        path: "apps/be-ai-assistant/src/chat/services/conversation_service.go",
        risk: "high",
        additions: 1,
        deletions: 0
      },
      { path: "apps/be-common/models/conversation_model.go", risk: "high", additions: 1, deletions: 0 },
      {
        path: "apps/be-database/db/migrations/000045_scope_conversation_threads_by_user.up.sql",
        risk: "high",
        additions: 1,
        deletions: 0
      }
    ],
    targetChangedLines: 10
  });

  assert.deepEqual(plan.chunks[0]?.paths.slice(0, 3), [
    "apps/be-ai-assistant/src/chat/services/conversation_service.go",
    "apps/be-common/models/conversation_model.go",
    "apps/be-database/db/migrations/000045_scope_conversation_threads_by_user.up.sql"
  ]);
});

test("buildReviewDiffChunkPlan separates chat controller affinity before high-risk tails", () => {
  const diffPatch = [
    filePatch("apps/be-ai-assistant/src/chat/controllers/chat_controller.go", ["c1", "c2"]),
    filePatch("packages/web-script/src/backend/opfs-queue.ts", ["q1", "q2"]),
    filePatch("apps/be-ai-assistant/src/chat/services/conversation_service.go", ["s1", "s2"])
  ].join("");

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: [
      { path: "apps/be-ai-assistant/src/chat/controllers/chat_controller.go", additions: 2, deletions: 0 },
      { path: "packages/web-script/src/backend/opfs-queue.ts", additions: 2, deletions: 0 },
      { path: "apps/be-ai-assistant/src/chat/services/conversation_service.go", additions: 2, deletions: 0 }
    ],
    changedFileStats: [
      {
        path: "apps/be-ai-assistant/src/chat/controllers/chat_controller.go",
        risk: "high",
        additions: 2,
        deletions: 0
      },
      {
        path: "packages/web-script/src/backend/opfs-queue.ts",
        risk: "high",
        additions: 2,
        deletions: 0
      },
      {
        path: "apps/be-ai-assistant/src/chat/services/conversation_service.go",
        risk: "high",
        additions: 2,
        deletions: 0
      }
    ],
    targetChangedLines: 10,
    highRiskTargetChangedLines: 10
  });

  assert.deepEqual(plan.chunks.map((chunk) => chunk.paths), [
    ["apps/be-ai-assistant/src/chat/services/conversation_service.go"],
    [
      "apps/be-ai-assistant/src/chat/controllers/chat_controller.go",
      "packages/web-script/src/backend/opfs-queue.ts"
    ]
  ]);
});

test("buildReviewDiffChunkPlan keeps infra security files together across modules", () => {
  const diffPatch = [
    filePatch("apps/be-database/patroni/pgbouncer.ini", ["auth_type = md5"]),
    filePatch("apps/be-database/patroni/patroni.yml", ["hostssl all all 0.0.0.0/0 md5"]),
    filePatch("apps/be-notification/deployment/rabbitmq/rabbitmq.conf", ["loopback_users.guest = false"]),
    filePatch("apps/be-ai-assistant/src/chat/services/conversation_service.go", ["s1"])
  ].join("");

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: [
      { path: "apps/be-database/patroni/pgbouncer.ini", additions: 1, deletions: 0 },
      { path: "apps/be-database/patroni/patroni.yml", additions: 1, deletions: 0 },
      { path: "apps/be-notification/deployment/rabbitmq/rabbitmq.conf", additions: 1, deletions: 0 },
      { path: "apps/be-ai-assistant/src/chat/services/conversation_service.go", additions: 1, deletions: 0 }
    ],
    changedFileStats: [
      { path: "apps/be-database/patroni/pgbouncer.ini", risk: "high", additions: 1, deletions: 0 },
      { path: "apps/be-database/patroni/patroni.yml", risk: "high", additions: 1, deletions: 0 },
      { path: "apps/be-notification/deployment/rabbitmq/rabbitmq.conf", risk: "high", additions: 1, deletions: 0 },
      {
        path: "apps/be-ai-assistant/src/chat/services/conversation_service.go",
        risk: "high",
        additions: 1,
        deletions: 0
      }
    ],
    targetChangedLines: 10
  });

  assert.deepEqual(plan.chunks[0]?.paths.slice(0, 3), [
    "apps/be-database/patroni/patroni.yml",
    "apps/be-database/patroni/pgbouncer.ini",
    "apps/be-notification/deployment/rabbitmq/rabbitmq.conf"
  ]);
});

test("buildReviewDiffChunkPlan uses smaller high-risk buckets", () => {
  const diffPatch = [
    filePatch("src/auth-a.ts", ["a1", "a2"]),
    filePatch("src/auth-b.ts", ["b1", "b2"]),
    filePatch("src/auth-c.ts", ["c1", "c2"])
  ].join("");

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: [
      { path: "src/auth-a.ts", additions: 2, deletions: 0 },
      { path: "src/auth-b.ts", additions: 2, deletions: 0 },
      { path: "src/auth-c.ts", additions: 2, deletions: 0 }
    ],
    changedFileStats: [
      { path: "src/auth-a.ts", risk: "high", additions: 2, deletions: 0 },
      { path: "src/auth-b.ts", risk: "high", additions: 2, deletions: 0 },
      { path: "src/auth-c.ts", risk: "high", additions: 2, deletions: 0 }
    ],
    targetChangedLines: 10,
    highRiskTargetChangedLines: 3,
    highRiskMaxChangedLines: 4
  });

  assert.deepEqual(plan.chunks.map((chunk) => chunk.changedLines), [2, 2, 2]);
  assert.equal(plan.stats.highRiskTargetChangedLines, 3);
});


test("buildReviewDiffChunkPlan creates useful chunks for one-thousand-line reviews", () => {
  const files = [
    ["apps/a/src/a.ts", 450],
    ["apps/a/src/b.ts", 350],
    ["apps/b/src/c.ts", 300],
    ["apps/b/src/d.ts", 200]
  ] as const;
  const diffPatch = files
    .map(([path, lines]) => filePatch(path, Array.from({ length: lines }, (_, index) => `${path} line ${index}`)))
    .join("");

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: files.map(([path, lines]) => ({ path, additions: lines, deletions: 0 })),
    changedFileStats: files.map(([path, lines]) => ({ path, risk: "low" as const, additions: lines, deletions: 0 })),
    targetChangedLines: 1000,
    maxChangedLines: 1800,
    highRiskTargetChangedLines: 700,
    highRiskMaxChangedLines: 1200,
    maxFiles: 240
  });

  assert.equal(plan.stats.totalChangedLines, 1300);
  assert.equal(plan.stats.targetChangedLines, 1000);
  assert.equal(plan.chunks.length, 2);
  assert.deepEqual(plan.chunks.map((chunk) => chunk.changedLines), [800, 500]);
});

test("buildReviewDiffChunkPlan caps files per chunk for low-churn tails", () => {
  const files = Array.from({ length: 5 }, (_, index) => `apps/a/src/file-${index}.ts`);
  const diffPatch = files.map((path) => filePatch(path, [`line ${path}`])).join("");

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: files.map((path) => ({ path, additions: 1, deletions: 0 })),
    targetChangedLines: 10,
    maxFiles: 2
  });

  assert.deepEqual(plan.chunks.map((chunk) => chunk.paths.length), [2, 2, 1]);
  assert.equal(plan.stats.maxFiles, 2);
});

test("buildReviewDiffChunkPlan keeps an oversized file in one chunk", () => {
  const diffPatch = filePatch("src/big.ts", Array.from({ length: 12 }, (_, index) => `line ${index}`));

  const plan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: [{ path: "src/big.ts", additions: 12, deletions: 0 }],
    targetChangedLines: 5,
    maxChangedLines: 8
  });

  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0]?.changedLines, 12);
  assert.equal(plan.stats.largestFileChangedLines, 12);
});

test("splitDiffByFile resolves deleted files to the original path", () => {
  const deletedPatch = [
    "diff --git a/src/deleted.ts b/src/deleted.ts",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/src/deleted.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone"
  ].join("\n");

  const sections = __diffChunkInternals.splitDiffByFile(`${deletedPatch}\n`);
  assert.equal(sections[0]?.path, "src/deleted.ts");
});

test("mergeChunkReviewDrafts preserves full chunk comments with unique ids", () => {
  const firstChunk: ReviewDiffChunk = {
    id: "chunk-01",
    ordinal: 0,
    paths: ["src/a.ts"],
    diffPatch: "",
    changedFiles: [],
    changedLines: 1,
    additions: 1,
    deletions: 0,
    risk: "low"
  };
  const secondChunk: ReviewDiffChunk = {
    ...firstChunk,
    id: "chunk-02",
    ordinal: 1,
    paths: ["src/b.ts"],
    risk: "high"
  };

  const merged = mergeChunkReviewDrafts({
    drafts: [
      { chunk: firstChunk, review: makeReview("a") },
      { chunk: secondChunk, review: makeReview("b", "high") }
    ],
    maxKeyConcerns: 4
  });

  assert.equal(merged.summary.risk, "high");
  assert.equal(merged.summary.confidence, 0.7);
  assert.equal(merged.comments.length, 2);
  assert.deepEqual(merged.comments.map((comment) => comment.comment_id), [
    "chunk-01:same-id",
    "chunk-02:same-id"
  ]);
});

test("mergeChunkReviewDrafts produces a compact overview for large chunked reviews", () => {
  const chunks: ReviewDiffChunk[] = [
    {
      id: "chunk-01",
      ordinal: 0,
      paths: ["docker-compose.yml", "Dockerfile"],
      diffPatch: "",
      changedFiles: [],
      changedLines: 200,
      additions: 200,
      deletions: 0,
      risk: "high"
    },
    {
      id: "chunk-02",
      ordinal: 1,
      paths: ["src/review/pipeline.ts"],
      diffPatch: "",
      changedFiles: [],
      changedLines: 120,
      additions: 120,
      deletions: 0,
      risk: "high"
    },
    {
      id: "chunk-03",
      ordinal: 2,
      paths: ["src/review/diffChunks.ts"],
      diffPatch: "",
      changedFiles: [],
      changedLines: 80,
      additions: 80,
      deletions: 0,
      risk: "medium"
    }
  ];

  const merged = mergeChunkReviewDrafts({
    drafts: [
      { chunk: chunks[0]!, review: makeReview("a", "high") },
      { chunk: chunks[1]!, review: makeReview("b", "high") },
      { chunk: chunks[2]!, review: makeReview("c", "medium") }
    ],
    maxKeyConcerns: 4
  });

  assert.match(merged.summary.overview, /^Top review findings: issue a; issue b; issue c\.$/);
  assert.doesNotMatch(merged.summary.overview, /Large PR reviewed/);
  assert.doesNotMatch(merged.summary.overview, /Highest-risk areas:/);
  assert.doesNotMatch(merged.summary.overview, /chunk-01 \(/);
});
