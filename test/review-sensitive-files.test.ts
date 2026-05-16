import test from "node:test";
import assert from "node:assert/strict";
import { renderPrMarkdown } from "../src/review/prMarkdown.js";
import { sanitizeModelVisibleReviewData } from "../src/review/sensitiveReviewData.js";

test("sanitizeModelVisibleReviewData strips sensitive diff sections and annotates changed files", () => {
  const diffPatch = [
    "diff --git a/.env b/.env",
    "index 1111111..2222222 100644",
    "--- a/.env",
    "+++ b/.env",
    "@@ -0,0 +1 @@",
    "+AWS_SECRET_ACCESS_KEY=super-secret",
    "diff --git a/src/app.ts b/src/app.ts",
    "index 3333333..4444444 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-export const mode = 'dev';",
    "+export const mode = 'prod';"
  ].join("\n");

  const result = sanitizeModelVisibleReviewData({
    diffPatch,
    changedFiles: [
      { path: ".env", status: "added", additions: 1, deletions: 0, patch: "+AWS_SECRET_ACCESS_KEY=super-secret" },
      { path: "src/app.ts", status: "modified", additions: 1, deletions: 1, patch: null }
    ]
  });

  assert.deepEqual(result.sensitivePaths, [".env"]);
  assert.doesNotMatch(result.diffPatch, /AWS_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(result.diffPatch, /diff --git a\/\.env b\/\.env/);
  assert.match(result.diffPatch, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);

  const envChange = result.changedFiles.find((item) => item.path === ".env");
  assert.ok(envChange);
  assert.equal(envChange?.patch, null);
  assert.equal(envChange?.sensitive, true);

  const sourceChange = result.changedFiles.find((item) => item.path === "src/app.ts");
  assert.equal(sourceChange?.sensitive, false);
});

test("sanitizeModelVisibleReviewData omits generated and lockfile bulk noise", () => {
  const diffPatch = [
    "diff --git a/package-lock.json b/package-lock.json",
    "index 1111111..2222222 100644",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1 @@",
    "-{\"lockfileVersion\":2}",
    "+{\"lockfileVersion\":3}",
    "diff --git a/apps/be-database/backup.sql b/apps/be-database/backup.sql",
    "index 1111111..2222222 100644",
    "--- a/apps/be-database/backup.sql",
    "+++ b/apps/be-database/backup.sql",
    "@@ -1 +1 @@",
    "-insert into sessions values (1);",
    "+insert into sessions values (2);",
    "diff --git a/src/app.ts b/src/app.ts",
    "index 3333333..4444444 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-export const mode = 'dev';",
    "+export const mode = 'prod';",
    "diff --git a/apps/create-next-app-src/src/data/components.ts b/apps/create-next-app-src/src/data/components.ts",
    "deleted file mode 100644",
    "index 5555555..0000000",
    "--- a/apps/create-next-app-src/src/data/components.ts",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-export const components = [",
    "-  'x',",
    "-];"
  ].join("\n");

  const result = sanitizeModelVisibleReviewData({
    diffPatch,
    changedFiles: [
      { path: "package-lock.json", status: "modified", additions: 1, deletions: 1, patch: "{}" },
      { path: "apps/be-database/backup.sql", status: "modified", additions: 1, deletions: 1, patch: null },
      { path: "src/app.ts", status: "modified", additions: 1, deletions: 1, patch: null },
      {
        path: "apps/create-next-app-src/src/data/components.ts",
        status: "removed",
        additions: 0,
        deletions: 1200,
        patch: null
      }
    ]
  });

  assert.deepEqual(result.bulkNoisePaths, [
    "package-lock.json",
    "apps/be-database/backup.sql",
    "apps/create-next-app-src/src/data/components.ts"
  ]);
  assert.doesNotMatch(result.diffPatch, /package-lock\.json/);
  assert.doesNotMatch(result.diffPatch, /backup\.sql/);
  assert.doesNotMatch(result.diffPatch, /components\.ts/);
  assert.match(result.diffPatch, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.deepEqual(result.changedFiles.map((item) => item.path), ["src/app.ts"]);
});

test("sanitizeModelVisibleReviewData omits low-signal bulk diffs only for large reviews", () => {
  const diffPatch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 3333333..4444444 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-export const mode = 'dev';",
    "+export const mode = 'prod';",
    "diff --git a/src/app.test.ts b/src/app.test.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.test.ts",
    "+++ b/src/app.test.ts",
    "@@ -1 +1 @@",
    "-expect(mode).toBe('dev');",
    "+expect(mode).toBe('prod');",
    "diff --git a/docs/guide.md b/docs/guide.md",
    "index 5555555..6666666 100644",
    "--- a/docs/guide.md",
    "+++ b/docs/guide.md",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");
  const changedFiles = [
    { path: "src/app.ts", status: "modified", additions: 40_000, deletions: 10_000, patch: null },
    { path: "src/app.test.ts", status: "modified", additions: 1, deletions: 1, patch: null },
    { path: "docs/guide.md", status: "modified", additions: 1, deletions: 1, patch: null }
  ];

  const largeResult = sanitizeModelVisibleReviewData({ diffPatch, changedFiles });
  assert.deepEqual(largeResult.bulkNoisePaths, ["src/app.test.ts", "docs/guide.md"]);
  assert.match(largeResult.diffPatch, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.doesNotMatch(largeResult.diffPatch, /app\.test\.ts/);
  assert.doesNotMatch(largeResult.diffPatch, /docs\/guide\.md/);

  const smallResult = sanitizeModelVisibleReviewData({
    diffPatch,
    changedFiles: changedFiles.map((item) => ({ ...item, additions: 1, deletions: 1 }))
  });
  assert.match(smallResult.diffPatch, /app\.test\.ts/);
  assert.match(smallResult.diffPatch, /docs\/guide\.md/);
});

test("renderPrMarkdown lists withheld sensitive file paths", () => {
  const markdown = renderPrMarkdown({
    title: "Rotate credentials",
    number: 56,
    author: "octocat",
    body: "Updates deployment config.",
    baseRef: "main",
    headRef: "rotate-secrets",
    headSha: "a".repeat(40),
    sensitivePathsWithheld: [".env", "deploy/production.pem"]
  });

  assert.match(markdown, /## Sensitive Files Withheld/);
  assert.match(markdown, /- \.env/);
  assert.match(markdown, /- deploy\/production\.pem/);
});
