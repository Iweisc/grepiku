import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSensitiveReadonlySearchGlobs,
  shouldBlockSensitiveRepoPath
} from "../docker/codex-runner/tools/readonly_sensitive_paths.js";

test("shouldBlockSensitiveRepoPath rejects common secret-bearing repo paths", () => {
  assert.equal(shouldBlockSensitiveRepoPath(".env"), true);
  assert.equal(shouldBlockSensitiveRepoPath("deploy/production.pem"), true);
  assert.equal(shouldBlockSensitiveRepoPath(".config/gh/hosts.yml"), true);
  assert.equal(shouldBlockSensitiveRepoPath("src/app.ts"), false);
});

test("buildSensitiveReadonlySearchGlobs excludes sensitive basenames, directories, and extensions", () => {
  const globs = buildSensitiveReadonlySearchGlobs();

  assert.ok(globs.includes("!**/.env"));
  assert.ok(globs.includes("!**/.env.*"));
  assert.ok(globs.includes("!**/*.pem"));
  assert.ok(globs.includes("!**/.aws/**"));
  assert.ok(globs.includes("!**/.config/gh/hosts.yml"));
});
