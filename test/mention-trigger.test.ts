import test from "node:test";
import assert from "node:assert/strict";
import { extractMentionDoTask } from "../src/review/triggers.js";
import type { RepoConfig } from "../src/review/config.js";

const baseConfig: RepoConfig = {
  ignore: [],
  graph: {
    exclude_dirs: ["internal_harness"],
    traversal: {
      max_depth: 5,
      min_score: 0.07,
      max_related_files: 24,
      max_graph_links: 80,
      hard_include_files: 8,
      max_nodes_visited: 2400
    }
  },
  tools: {},
  limits: { max_inline_comments: 20, max_key_concerns: 5 },
  rules: [],
  scopes: [],
  patternRepositories: [],
  strictness: "medium",
  commentTypes: { allow: ["inline", "summary"] },
  output: { summaryOnly: false, destination: "comment" },
  retrieval: {
    topK: 18,
    maxPerPath: 4,
    semanticWeight: 0.62,
    lexicalWeight: 0.22,
    rrfWeight: 0.08,
    changedPathBoost: 0.16,
    sameDirectoryBoost: 0.08,
    patternBoost: 0.03,
    symbolBoost: 0.02,
    chunkBoost: 0.03
  },
  statusChecks: { name: "Grepiku Review", required: false },
  triggers: {
    manualOnly: false,
    allowAutoOnPush: true,
    labels: { include: [], exclude: [] },
    branches: { include: [], exclude: [] },
    authors: { include: [], exclude: [] },
    keywords: { include: [], exclude: [] },
    commentTriggers: ["/review", "@grepiku"]
  }
};

test("extractMentionDoTask returns command text for prefixed mention", () => {
  const task = extractMentionDoTask("@grepiku do: add unit tests for retry logic", baseConfig);
  assert.equal(task, "add unit tests for retry logic");
});

test("extractMentionDoTask captures multiline command body", () => {
  const body = "@grepiku do:\n1. refactor mention routing\n2. keep backwards compatibility";
  const task = extractMentionDoTask(body, baseConfig);
  assert.equal(task, "1. refactor mention routing\n2. keep backwards compatibility");
});

test("extractMentionDoTask ignores plain mentions without do prefix", () => {
  const task = extractMentionDoTask("@grepiku what changed in this PR?", baseConfig);
  assert.equal(task, null);
});
