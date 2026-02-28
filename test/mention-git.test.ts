import test from "node:test";
import assert from "node:assert/strict";
import { isGitPermissionDeniedError, resolveFollowUpPrBaseBranch } from "../src/review/mentionGit.js";

test("resolveFollowUpPrBaseBranch prefers pull request head ref for follow-up PRs", () => {
  const base = resolveFollowUpPrBaseBranch({
    pullRequestHeadRef: "dev",
    pullRequestBaseRef: "release/1.2",
    refreshedHeadRef: "feature/x",
    refreshedBaseRef: "main",
    repoDefaultBranch: "develop"
  });
  assert.equal(base, "dev");
});

test("resolveFollowUpPrBaseBranch falls back to refreshed base ref", () => {
  const base = resolveFollowUpPrBaseBranch({
    pullRequestHeadRef: null,
    pullRequestBaseRef: null,
    refreshedHeadRef: null,
    refreshedBaseRef: "main",
    repoDefaultBranch: "develop"
  });
  assert.equal(base, "main");
});

test("resolveFollowUpPrBaseBranch falls back to repo default and then main", () => {
  const withDefault = resolveFollowUpPrBaseBranch({
    pullRequestHeadRef: "",
    pullRequestBaseRef: "",
    refreshedHeadRef: null,
    refreshedBaseRef: null,
    repoDefaultBranch: "develop"
  });
  assert.equal(withDefault, "develop");

  const fallbackMain = resolveFollowUpPrBaseBranch({
    pullRequestHeadRef: null,
    pullRequestBaseRef: null,
    refreshedHeadRef: undefined,
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
