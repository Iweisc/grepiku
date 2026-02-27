import test from "node:test";
import assert from "node:assert/strict";
import { isGeneratedMentionReply, isSelfBotComment, normalizeBotAwareLogin } from "../src/providers/commentGuards.js";

test("normalizeBotAwareLogin strips [bot] suffix", () => {
  assert.equal(normalizeBotAwareLogin("grepiku-dev[bot]"), "grepiku-dev");
  assert.equal(normalizeBotAwareLogin("grepiku-dev"), "grepiku-dev");
});

test("isSelfBotComment matches bot login with or without [bot] suffix", () => {
  assert.equal(
    isSelfBotComment({
      authorLogin: "grepiku-dev[bot]",
      botLogin: "grepiku-dev"
    }),
    true
  );
  assert.equal(
    isSelfBotComment({
      authorLogin: "grepiku-dev",
      botLogin: "grepiku-dev[bot]"
    }),
    true
  );
});

test("isSelfBotComment does not match unrelated bots or users", () => {
  assert.equal(
    isSelfBotComment({
      authorLogin: "dependabot[bot]",
      botLogin: "grepiku-dev"
    }),
    false
  );
  assert.equal(
    isSelfBotComment({
      authorLogin: "Iweisc",
      botLogin: "grepiku-dev"
    }),
    false
  );
});

test("isGeneratedMentionReply detects mention marker only", () => {
  assert.equal(isGeneratedMentionReply("<!-- grepiku-mention:2862044956 -->\n@grepiku-dev[bot] ok"), true);
  assert.equal(isGeneratedMentionReply("<!-- grepiku:cmt-1 -->"), false);
});
