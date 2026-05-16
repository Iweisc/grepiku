import assert from "node:assert/strict";
import test from "node:test";

import { mergeStoredPullRequestState } from "../src/review/pullRequestState.js";

test("mergeStoredPullRequestState preserves explicit PR body clears", () => {
  const merged = mergeStoredPullRequestState(
    {
      title: "Existing title",
      body: "OLD MALICIOUS BODY",
      url: "https://example.test/pr/1",
      state: "open",
      baseRef: "main",
      headRef: "feature",
      baseSha: "base-sha",
      headSha: "head-sha",
      draft: false
    },
    {
      externalId: "1",
      number: 1,
      title: "Existing title",
      body: null,
      url: "https://example.test/pr/1",
      state: "open",
      baseRef: "main",
      headRef: "feature",
      baseSha: "base-sha",
      headSha: "head-sha",
      draft: false
    }
  );

  assert.equal(merged.body, null);
});

test("mergeStoredPullRequestState preserves explicit empty PR bodies", () => {
  const merged = mergeStoredPullRequestState(
    {
      title: "Existing title",
      body: "OLD BODY",
      url: "https://example.test/pr/1",
      state: "open",
      baseRef: "main",
      headRef: "feature",
      baseSha: "base-sha",
      headSha: "head-sha",
      draft: false
    },
    {
      externalId: "1",
      number: 1,
      title: "Existing title",
      body: "",
      url: "https://example.test/pr/1",
      state: "open",
      baseRef: "main",
      headRef: "feature",
      baseSha: "base-sha",
      headSha: "head-sha",
      draft: false
    }
  );

  assert.equal(merged.body, "");
});

test("mergeStoredPullRequestState falls back only when a provider field is missing", () => {
  const merged = mergeStoredPullRequestState(
    {
      title: "Existing title",
      body: "Existing body",
      url: "https://example.test/pr/1",
      state: "open",
      baseRef: "main",
      headRef: "feature",
      baseSha: "base-sha",
      headSha: "head-sha",
      draft: false
    },
    {
      externalId: "1",
      number: 1,
      state: "open",
      headSha: "head-sha"
    }
  );

  assert.equal(merged.title, "Existing title");
  assert.equal(merged.body, "Existing body");
  assert.equal(merged.url, "https://example.test/pr/1");
  assert.equal(merged.baseRef, "main");
  assert.equal(merged.headRef, "feature");
  assert.equal(merged.baseSha, "base-sha");
});
