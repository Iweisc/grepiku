import test from "node:test";
import assert from "node:assert/strict";
import { isGitPermissionDeniedError, resolveFollowUpPrBaseBranch } from "../src/review/mentionGit.js";

test("resolveFollowUpPrBaseBranch prefers pull request base ref", () => {
  const base = resolveFollowUpPrBaseBranch({
    pullRequestBaseRef: "release/1.2",
    refreshedBaseRef: "main",
    repoDefaultBranch: "develop"
  });
  assert.equal(base, "release/1.2");
});

test("resolveFollowUpPrBaseBranch falls back to refreshed base ref", () => {
  const base = resolveFollowUpPrBaseBranch({
    pullRequestBaseRef: null,
    refreshedBaseRef: "main",
    repoDefaultBranch: "develop"
  });
  assert.equal(base, "main");
});

test("resolveFollowUpPrBaseBranch falls back to repo default and then main", () => {
  const withDefault = resolveFollowUpPrBaseBranch({
    pullRequestBaseRef: "",
    refreshedBaseRef: null,
    repoDefaultBranch: "develop"
  });
  assert.equal(withDefault, "develop");

  const fallbackMain = resolveFollowUpPrBaseBranch({
    pullRequestBaseRef: null,
    refreshedBaseRef: undefined,
    repoDefaultBranch: ""
  });
  assert.equal(fallbackMain, "main");
});

test("isGitPermissionDeniedError detects push permission failures", () => {
  assert.equal(
    isGitPermissionDeniedError(new Error("remote: Permission to org/repo.git denied to bot[bot].")),
    true
  );
  assert.equal(
    isGitPermissionDeniedError(new Error("The requested URL returned error: 403")),
    true
  );
  assert.equal(isGitPermissionDeniedError(new Error("fatal: not a git repository")), false);
});

test("isGitPermissionDeniedError ignores known non-permission 403 failures", () => {
  assert.equal(
    isGitPermissionDeniedError(new Error("The requested URL returned error: 403 - API rate limit exceeded")),
    false
  );
  assert.equal(
    isGitPermissionDeniedError(new Error("HTTP 403 secondary rate limit hit, retry later")),
    false
  );
  assert.equal(
    isGitPermissionDeniedError(new Error("HTTP 403 due to abuse detection mechanism")),
    false
  );
});
