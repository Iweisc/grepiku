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
