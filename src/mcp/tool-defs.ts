import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool argument schemas – pure definitions, no side effects
// ---------------------------------------------------------------------------

export const toolSchemas = {
  pr_listComments: {
    repo: z.string().describe("Repository full name (owner/repo)"),
    prNumber: z.number().int().positive().describe("Pull request number")
  },
  pr_getUnaddressed: {
    repo: z.string().describe("Repository full name (owner/repo)"),
    prNumber: z.number().int().positive().describe("Pull request number")
  },
  pr_applySuggestion: {
    findingId: z.number().int().positive().describe("Finding ID")
  },
  patterns_search: {
    repo: z.string().describe("Repository full name (owner/repo)"),
    query: z.string().describe("Search query for pattern matching")
  },
  standards_list: {
    repo: z.string().describe("Repository full name (owner/repo)")
  },
  standards_add: {
    repo: z.string().describe("Repository full name (owner/repo)"),
    text: z.string().min(1).describe("Standard text to add")
  },
  reports_weekly: {
    repo: z.string().describe("Repository full name (owner/repo)")
  }
} as const;

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    name: "pr_listComments",
    description: "List all review comments for a pull request",
    schema: toolSchemas.pr_listComments
  },
  {
    name: "pr_getUnaddressed",
    description: "Get unaddressed (open) findings for a pull request",
    schema: toolSchemas.pr_getUnaddressed
  },
  {
    name: "pr_applySuggestion",
    description: "Get the suggested patch for a finding",
    schema: toolSchemas.pr_applySuggestion
  },
  {
    name: "patterns_search",
    description: "Search feedback patterns by category or title",
    schema: toolSchemas.patterns_search
  },
  {
    name: "standards_list",
    description: "List accepted repo standards (memory rules)",
    schema: toolSchemas.standards_list
  },
  {
    name: "standards_add",
    description: "Add a new repo standard",
    schema: toolSchemas.standards_add
  },
  {
    name: "reports_weekly",
    description: "Generate a weekly review report for the last 7 days",
    schema: toolSchemas.reports_weekly
  }
] as const;
