import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toolDefinitions, toolSchemas } from "../src/mcp/tool-defs.js";

// ---------------------------------------------------------------------------
// Tool registration tests
// ---------------------------------------------------------------------------

test("toolDefinitions contains all expected tool names", () => {
  const names = toolDefinitions.map((t) => t.name);
  assert.deepEqual(names, [
    "pr_listComments",
    "pr_getUnaddressed",
    "pr_applySuggestion",
    "patterns_search",
    "standards_list",
    "standards_add",
    "reports_weekly"
  ]);
});

test("every tool definition has a description", () => {
  for (const tool of toolDefinitions) {
    assert.ok(
      typeof tool.description === "string" && tool.description.length > 0,
      `Tool ${tool.name} should have a non-empty description`
    );
  }
});

test("every tool definition has a schema object", () => {
  for (const tool of toolDefinitions) {
    assert.ok(tool.schema !== null && typeof tool.schema === "object", `Tool ${tool.name} should have a schema`);
  }
});

// ---------------------------------------------------------------------------
// pr_listComments schema validation
// ---------------------------------------------------------------------------

test("pr_listComments schema accepts valid args", () => {
  const schema = z.object(toolSchemas.pr_listComments);
  const result = schema.safeParse({ repo: "owner/repo", prNumber: 42 });
  assert.ok(result.success, "Should accept valid repo and prNumber");
});

test("pr_listComments schema rejects missing repo", () => {
  const schema = z.object(toolSchemas.pr_listComments);
  const result = schema.safeParse({ prNumber: 42 });
  assert.ok(!result.success, "Should reject when repo is missing");
});

test("pr_listComments schema rejects non-integer prNumber", () => {
  const schema = z.object(toolSchemas.pr_listComments);
  const result = schema.safeParse({ repo: "owner/repo", prNumber: 3.14 });
  assert.ok(!result.success, "Should reject non-integer prNumber");
});

test("pr_listComments schema rejects negative prNumber", () => {
  const schema = z.object(toolSchemas.pr_listComments);
  const result = schema.safeParse({ repo: "owner/repo", prNumber: -1 });
  assert.ok(!result.success, "Should reject negative prNumber");
});

// ---------------------------------------------------------------------------
// pr_getUnaddressed schema validation
// ---------------------------------------------------------------------------

test("pr_getUnaddressed schema accepts valid args", () => {
  const schema = z.object(toolSchemas.pr_getUnaddressed);
  const result = schema.safeParse({ repo: "org/project", prNumber: 100 });
  assert.ok(result.success, "Should accept valid repo and prNumber");
});

test("pr_getUnaddressed schema rejects missing prNumber", () => {
  const schema = z.object(toolSchemas.pr_getUnaddressed);
  const result = schema.safeParse({ repo: "org/project" });
  assert.ok(!result.success, "Should reject when prNumber is missing");
});

// ---------------------------------------------------------------------------
// pr_applySuggestion schema validation
// ---------------------------------------------------------------------------

test("pr_applySuggestion schema accepts valid findingId", () => {
  const schema = z.object(toolSchemas.pr_applySuggestion);
  const result = schema.safeParse({ findingId: 1 });
  assert.ok(result.success, "Should accept valid findingId");
});

test("pr_applySuggestion schema rejects zero findingId", () => {
  const schema = z.object(toolSchemas.pr_applySuggestion);
  const result = schema.safeParse({ findingId: 0 });
  assert.ok(!result.success, "Should reject zero findingId");
});

test("pr_applySuggestion schema rejects string findingId", () => {
  const schema = z.object(toolSchemas.pr_applySuggestion);
  const result = schema.safeParse({ findingId: "abc" });
  assert.ok(!result.success, "Should reject string findingId");
});

// ---------------------------------------------------------------------------
// patterns_search schema validation
// ---------------------------------------------------------------------------

test("patterns_search schema accepts valid args", () => {
  const schema = z.object(toolSchemas.patterns_search);
  const result = schema.safeParse({ repo: "owner/repo", query: "security" });
  assert.ok(result.success, "Should accept valid repo and query");
});

test("patterns_search schema rejects missing query", () => {
  const schema = z.object(toolSchemas.patterns_search);
  const result = schema.safeParse({ repo: "owner/repo" });
  assert.ok(!result.success, "Should reject when query is missing");
});

// ---------------------------------------------------------------------------
// standards_list schema validation
// ---------------------------------------------------------------------------

test("standards_list schema accepts valid repo", () => {
  const schema = z.object(toolSchemas.standards_list);
  const result = schema.safeParse({ repo: "owner/repo" });
  assert.ok(result.success, "Should accept valid repo");
});

test("standards_list schema rejects empty input", () => {
  const schema = z.object(toolSchemas.standards_list);
  const result = schema.safeParse({});
  assert.ok(!result.success, "Should reject when repo is missing");
});

// ---------------------------------------------------------------------------
// standards_add schema validation
// ---------------------------------------------------------------------------

test("standards_add schema accepts valid args", () => {
  const schema = z.object(toolSchemas.standards_add);
  const result = schema.safeParse({ repo: "owner/repo", text: "Always use strict mode" });
  assert.ok(result.success, "Should accept valid repo and text");
});

test("standards_add schema rejects empty text", () => {
  const schema = z.object(toolSchemas.standards_add);
  const result = schema.safeParse({ repo: "owner/repo", text: "" });
  assert.ok(!result.success, "Should reject empty text");
});

test("standards_add schema rejects missing text", () => {
  const schema = z.object(toolSchemas.standards_add);
  const result = schema.safeParse({ repo: "owner/repo" });
  assert.ok(!result.success, "Should reject when text is missing");
});

// ---------------------------------------------------------------------------
// reports_weekly schema validation
// ---------------------------------------------------------------------------

test("reports_weekly schema accepts valid repo", () => {
  const schema = z.object(toolSchemas.reports_weekly);
  const result = schema.safeParse({ repo: "owner/repo" });
  assert.ok(result.success, "Should accept valid repo");
});

test("reports_weekly schema rejects numeric repo", () => {
  const schema = z.object(toolSchemas.reports_weekly);
  const result = schema.safeParse({ repo: 123 });
  assert.ok(!result.success, "Should reject numeric repo");
});
