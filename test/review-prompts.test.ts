import assert from "node:assert/strict";
import test from "node:test";
import type { RepoConfig } from "../src/review/config.js";
import { buildEditorPrompt, buildReviewerPrompt } from "../src/review/prompts.js";

const config = {
  limits: {
    max_inline_comments: 20,
    max_key_concerns: 5
  }
} as unknown as RepoConfig;

const paths = {
  repoPath: "/repo",
  bundleDir: "/bundle",
  outDir: "/out"
};

test("reviewer prompt keeps diff-only rule by default", () => {
  const prompt = buildReviewerPrompt(config, paths);
  assert.match(prompt, /Only comment on lines that exist in diff\.patch\./);
  assert.doesNotMatch(prompt, /full repository static audit/i);
});

test("reviewer prompt enables first-run full-repo static audit guidance", () => {
  const prompt = buildReviewerPrompt(config, paths, { fullRepoStaticAudit: true });
  assert.match(prompt, /full repository static audit/i);
  assert.match(prompt, /comment_type: "summary"/i);
});

test("editor prompt allows off-diff summary comments only in full-repo mode", () => {
  const defaultPrompt = buildEditorPrompt("{}", paths);
  assert.match(defaultPrompt, /Only comment on diff lines\./);

  const fullAuditPrompt = buildEditorPrompt("{}", paths, { fullRepoStaticAudit: true });
  assert.match(fullAuditPrompt, /Inline comments must be on diff lines\./);
  assert.match(fullAuditPrompt, /Summary comments may cover issues outside diff\.patch/i);
});
