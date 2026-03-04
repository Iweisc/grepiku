import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { prisma } from "../db/client.js";
import { loadAcceptedRepoMemoryRules } from "../services/repoMemory.js";
import { toolSchemas } from "./tool-defs.js";

// Re-export for convenience
export { toolSchemas, toolDefinitions } from "./tool-defs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveRepo(fullName: string) {
  const repo = await prisma.repo.findFirst({ where: { fullName } });
  if (!repo) throw new Error(`Repository not found: ${fullName}`);
  return repo;
}

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "grepiku-ide",
    version: "1.0.0"
  });

  // -- pr_listComments -------------------------------------------------------
  server.tool(
    "pr_listComments",
    "List all review comments for a pull request",
    toolSchemas.pr_listComments,
    async ({ repo: fullName, prNumber }) => {
      const repo = await resolveRepo(fullName);
      const pr = await prisma.pullRequest.findFirst({
        where: { repoId: repo.id, number: prNumber }
      });
      if (!pr) {
        return { content: [{ type: "text", text: `PR #${prNumber} not found in ${fullName}` }] };
      }

      const comments = await prisma.reviewComment.findMany({
        where: { pullRequestId: pr.id },
        include: { finding: true },
        orderBy: { createdAt: "asc" }
      });

      const result = comments.map((c) => ({
        id: c.id,
        kind: c.kind,
        body: c.body,
        url: c.url,
        finding: c.finding
          ? {
              id: c.finding.id,
              status: c.finding.status,
              severity: c.finding.severity,
              category: c.finding.category,
              title: c.finding.title,
              path: c.finding.path,
              line: c.finding.line
            }
          : null
      }));

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // -- pr_getUnaddressed -----------------------------------------------------
  server.tool(
    "pr_getUnaddressed",
    "Get unaddressed (open) findings for a pull request",
    toolSchemas.pr_getUnaddressed,
    async ({ repo: fullName, prNumber }) => {
      const repo = await resolveRepo(fullName);
      const pr = await prisma.pullRequest.findFirst({
        where: { repoId: repo.id, number: prNumber }
      });
      if (!pr) {
        return { content: [{ type: "text", text: `PR #${prNumber} not found in ${fullName}` }] };
      }

      const findings = await prisma.finding.findMany({
        where: { pullRequestId: pr.id, status: "open" },
        orderBy: { createdAt: "asc" }
      });

      const result = findings.map((f) => ({
        id: f.id,
        path: f.path,
        line: f.line,
        severity: f.severity,
        category: f.category,
        title: f.title,
        body: f.body,
        evidence: f.evidence,
        suggestedPatch: f.suggestedPatch,
        ruleId: f.ruleId
      }));

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // -- pr_applySuggestion ----------------------------------------------------
  server.tool(
    "pr_applySuggestion",
    "Get the suggested patch for a finding",
    toolSchemas.pr_applySuggestion,
    async ({ findingId }) => {
      const finding = await prisma.finding.findFirst({
        where: { id: findingId }
      });
      if (!finding) {
        return { content: [{ type: "text", text: `Finding ${findingId} not found` }] };
      }
      if (!finding.suggestedPatch) {
        return {
          content: [{ type: "text", text: `Finding ${findingId} has no suggested patch` }]
        };
      }

      const result = {
        findingId: finding.id,
        path: finding.path,
        line: finding.line,
        title: finding.title,
        suggestedPatch: finding.suggestedPatch
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // -- patterns_search -------------------------------------------------------
  server.tool(
    "patterns_search",
    "Search feedback patterns by category or title",
    toolSchemas.patterns_search,
    async ({ repo: fullName, query }) => {
      const repo = await resolveRepo(fullName);
      const lowerQuery = query.toLowerCase();

      // Search findings that match the query by category or title
      const findings = await prisma.finding.findMany({
        where: {
          pullRequest: { repoId: repo.id },
          OR: [
            { category: { contains: lowerQuery, mode: "insensitive" } },
            { title: { contains: lowerQuery, mode: "insensitive" } }
          ]
        },
        orderBy: { createdAt: "desc" },
        take: 100
      });

      // Aggregate by category + title
      const buckets = new Map<string, { category: string; title: string; count: number; severities: Record<string, number> }>();
      for (const f of findings) {
        const key = `${f.category}:${f.title}`;
        const bucket = buckets.get(key) || { category: f.category, title: f.title, count: 0, severities: {} };
        bucket.count += 1;
        bucket.severities[f.severity] = (bucket.severities[f.severity] || 0) + 1;
        buckets.set(key, bucket);
      }

      // Also check feedback sentiment
      const feedbackData = await prisma.feedback.findMany({
        where: {
          reviewRun: { pullRequest: { repoId: repo.id } }
        },
        orderBy: { createdAt: "desc" },
        take: 200
      });

      const result = {
        patterns: Array.from(buckets.values()).sort((a, b) => b.count - a.count),
        totalFindings: findings.length,
        totalFeedback: feedbackData.length
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // -- standards_list --------------------------------------------------------
  server.tool(
    "standards_list",
    "List accepted repo standards (memory rules)",
    toolSchemas.standards_list,
    async ({ repo: fullName }) => {
      const repo = await resolveRepo(fullName);
      const rules = await loadAcceptedRepoMemoryRules(repo.id);

      const result = rules.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        severity: r.severity,
        category: r.category,
        pattern: r.pattern,
        scope: r.scope
      }));

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // -- standards_add ---------------------------------------------------------
  server.tool(
    "standards_add",
    "Add a new repo standard",
    toolSchemas.standards_add,
    async ({ repo: fullName, text }) => {
      const repo = await resolveRepo(fullName);

      const reason = `memory:${text.toLowerCase().replace(/\s+/g, " ").trim()}`;

      // Check for duplicates
      const existing = await prisma.ruleSuggestion.findFirst({
        where: { repoId: repo.id, reason }
      });
      if (existing) {
        return {
          content: [{ type: "text", text: JSON.stringify({ created: false, reason: "duplicate" }, null, 2) }]
        };
      }

      const ruleId = `memory-${Buffer.from(text).toString("hex").slice(0, 12)}`;
      const suggestion = await prisma.ruleSuggestion.create({
        data: {
          repoId: repo.id,
          status: "accepted",
          reason,
          ruleJson: {
            id: ruleId,
            title: `Team preference: ${text}`.slice(0, 110),
            description: `IDE-added standard: ${text}`,
            severity: "important",
            category: "maintainability",
            commentType: "inline",
            strictness: "medium",
            pattern: text,
            scope: "**/*",
            source: "ide_mcp"
          }
        }
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ created: true, id: suggestion.id, ruleId }, null, 2) }]
      };
    }
  );

  // -- reports_weekly --------------------------------------------------------
  server.tool(
    "reports_weekly",
    "Generate a weekly review report for the last 7 days",
    toolSchemas.reports_weekly,
    async ({ repo: fullName }) => {
      const repo = await resolveRepo(fullName);
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Count review runs
      const runs = await prisma.reviewRun.findMany({
        where: {
          pullRequest: { repoId: repo.id },
          createdAt: { gte: since }
        },
        include: { findings: true, feedback: true }
      });

      const totalRuns = runs.length;
      const completedRuns = runs.filter((r) => r.status === "completed").length;
      const failedRuns = runs.filter((r) => r.status === "failed").length;

      // Aggregate findings
      const allFindings = runs.flatMap((r) => r.findings);
      const findingsBySeverity: Record<string, number> = {};
      const findingsByCategory: Record<string, number> = {};
      for (const f of allFindings) {
        findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
        findingsByCategory[f.category] = (findingsByCategory[f.category] || 0) + 1;
      }

      // Acceptance rate from feedback
      const allFeedback = runs.flatMap((r) => r.feedback);
      const positiveReactions = new Set(["thumbs_up", "+1", "heart", "laugh", "hooray"]);
      const negativeReactions = new Set(["thumbs_down", "-1", "confused"]);
      let positive = 0;
      let negative = 0;
      for (const fb of allFeedback) {
        if (fb.type === "reaction" && fb.sentiment) {
          if (positiveReactions.has(fb.sentiment)) positive += 1;
          if (negativeReactions.has(fb.sentiment)) negative += 1;
        }
        if (fb.type === "reply" && fb.action === "resolved") positive += 1;
      }
      const totalReactions = positive + negative;
      const acceptanceRate = totalReactions > 0 ? Math.round((positive / totalReactions) * 100) : null;

      const result = {
        period: { from: since.toISOString(), to: new Date().toISOString() },
        runs: { total: totalRuns, completed: completedRuns, failed: failedRuns },
        findings: {
          total: allFindings.length,
          bySeverity: findingsBySeverity,
          byCategory: findingsByCategory
        },
        feedback: {
          positive,
          negative,
          acceptanceRate: acceptanceRate !== null ? `${acceptanceRate}%` : "N/A"
        }
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Main entry point – starts the stdio transport
// ---------------------------------------------------------------------------

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the server when this file is the entry point (not when imported)
const isEntryPoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("ide-server.ts") ||
  process.argv[1]?.endsWith("ide-server.js");

if (isEntryPoint) {
  main().catch((err) => {
    console.error("MCP IDE Server failed to start:", err);
    process.exit(1);
  });
}
