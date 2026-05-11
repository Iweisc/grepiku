import test from "node:test";
import assert from "node:assert/strict";
import { renderPrMarkdown } from "../src/review/prMarkdown.js";

test("renderPrMarkdown truncates oversized PR titles and descriptions", () => {
  const title = `${"T".repeat(500)}TRAILER-TITLE`;
  const body = `${"B".repeat(20_000)}TRAILER-BODY`;

  const markdown = renderPrMarkdown({
    title,
    number: 42,
    author: "octocat",
    body,
    baseRef: "main",
    headRef: "feature/security-fix",
    headSha: "a".repeat(40),
    url: "https://github.com/acme/widgets/pull/42"
  });

  assert.match(markdown, /^# PR #42:/);
  assert.match(markdown, /## Description/);
  assert.doesNotMatch(markdown, /TRAILER-TITLE/);
  assert.doesNotMatch(markdown, /TRAILER-BODY/);
  assert.match(markdown, /\[pr title truncated\]/i);
  assert.match(markdown, /\[pr description truncated\]/i);
});
