import test from "node:test";
import assert from "node:assert/strict";
import { resolveFollowUpPrBaseBranch } from "../src/review/mentionGit.js";

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
