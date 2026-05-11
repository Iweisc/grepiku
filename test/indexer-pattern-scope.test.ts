import test from "node:test";
import assert from "node:assert/strict";

test("pattern repository file paths are namespaced by source repository", async () => {
  const { buildIndexedFilePath } = await import("../src/services/indexerScope.js");

  const basePath = buildIndexedFilePath("rules/sql-injection.md");
  const firstPatternPath = buildIndexedFilePath("rules/sql-injection.md", {
    url: "https://github.com/acme/security-patterns.git",
    name: "security-patterns"
  });
  const renamedSameRepoPath = buildIndexedFilePath("rules/sql-injection.md", {
    url: "https://github.com/acme/security-patterns.git",
    name: "renamed-patterns"
  });
  const secondPatternPath = buildIndexedFilePath("rules/sql-injection.md", {
    url: "https://github.com/acme/style-patterns.git",
    name: "style-patterns"
  });

  assert.equal(basePath, "rules/sql-injection.md");
  assert.match(firstPatternPath, /^\.grepiku\/patterns\/[a-f0-9]{12}\/rules\/sql-injection\.md$/);
  assert.equal(renamedSameRepoPath, firstPatternPath);
  assert.notEqual(firstPatternPath, secondPatternPath);
});

test("pattern repository file paths are also namespaced by ref", async () => {
  const { buildIndexedFilePath } = await import("../src/services/indexerScope.js");

  const mainRefPath = buildIndexedFilePath("rules/sql-injection.md", {
    url: "https://github.com/acme/security-patterns.git",
    ref: "main"
  });
  const releaseRefPath = buildIndexedFilePath("rules/sql-injection.md", {
    url: "https://github.com/acme/security-patterns.git",
    ref: "release/1.0"
  });

  assert.notEqual(mainRefPath, releaseRefPath);
});

test("stale pattern-file pruning is scoped to the current pattern repository namespace", async () => {
  const { buildIndexedFilePath, buildPruneIndexedFilesWhere } = await import(
    "../src/services/indexerScope.js"
  );

  const firstPatternPath = buildIndexedFilePath("rules/sql-injection.md", {
    url: "https://github.com/acme/security-patterns.git"
  });
  const secondPatternPath = buildIndexedFilePath("rules/sql-injection.md", {
    url: "https://github.com/acme/style-patterns.git"
  });
  const firstPrefix = `${firstPatternPath.split("/").slice(0, 3).join("/")}/`;
  const secondPrefix = `${secondPatternPath.split("/").slice(0, 3).join("/")}/`;

  const firstWhere = buildPruneIndexedFilesWhere({
    repoId: 42,
    isPattern: true,
    keepFileIds: [101],
    patternRepo: { url: "https://github.com/acme/security-patterns.git" }
  });
  const baseWhere = buildPruneIndexedFilesWhere({
    repoId: 42,
    isPattern: false,
    keepFileIds: [201]
  });

  assert.equal(firstWhere.repoId, 42);
  assert.equal(firstWhere.isPattern, true);
  assert.deepEqual(firstWhere.id, { notIn: [101] });
  assert.equal(firstWhere.path?.startsWith, firstPrefix);
  assert.notEqual(firstWhere.path?.startsWith, secondPrefix);

  assert.equal(baseWhere.repoId, 42);
  assert.equal(baseWhere.isPattern, false);
  assert.deepEqual(baseWhere.id, { notIn: [201] });
  assert.equal("path" in baseWhere, false);
});
