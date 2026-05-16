import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { prisma } from "../db/client.js";
import { loadAcceptedRepoMemoryRules } from "../services/repoMemory.js";
import {
  formatAcceptanceRate,
  summarizeTrackedTrustedFeedback
} from "../services/feedbackMetrics.js";
import { toolSchemas } from "./tool-defs.js";

// Re-export for convenience
export { toolSchemas, toolDefinitions } from "./tool-defs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRepoFullName(value: string): string {
  return value.trim().replace(/\.git$/i, "").toLowerCase();
}

const GITHUB_REPO_FULL_NAME_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;

export function parseGithubRepoFullNameFromRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return normalizeRepoFullName(`${httpsMatch[1]}/${httpsMatch[2]}`);
  }

  const sshMatch = trimmed.match(
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
  );
  if (sshMatch) {
    return normalizeRepoFullName(`${sshMatch[1]}/${sshMatch[2]}`);
  }

  return null;
}

function parseIdeRepoFullName(value: string | null | undefined): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return null;
  }

  const fromRemote = parseGithubRepoFullNameFromRemote(trimmed);
  if (fromRemote) {
    return fromRemote;
  }

  if (!GITHUB_REPO_FULL_NAME_PATTERN.test(trimmed)) {
    return null;
  }

  return normalizeRepoFullName(trimmed);
}

export function resolveConfiguredIdeActiveRepoFullName(value: string | null | undefined): string {
  const parsed = parseIdeRepoFullName(value);
  if (parsed) {
    return parsed;
  }

  throw new Error(
    "IDE MCP active repository is not configured. Set GREPIKU_IDE_ACTIVE_REPO to an explicit owner/repo scope before starting the server."
  );
}

export function assertIdeRepoScope(requestedFullName: string, activeFullName: string): string {
  const requested = parseIdeRepoFullName(requestedFullName);
  const active = parseIdeRepoFullName(activeFullName);
  if (!requested || !active) {
    throw new Error("IDE MCP repository scope is not configured");
  }
  if (requested !== active) {
    throw new Error(
      `Repository ${requestedFullName} is outside the active repository scope (${activeFullName})`
    );
  }
  return active;
}

async function resolveActiveRepoFullName(): Promise<string> {
  return resolveConfiguredIdeActiveRepoFullName(process.env.GREPIKU_IDE_ACTIVE_REPO);
}

async function resolveRepo(fullName: string, activeRepoPromise: Promise<string>) {
  const scopedFullName = assertIdeRepoScope(fullName, await activeRepoPromise);
  const repo = await prisma.repo.findFirst({
    where: {
      fullName: {
        equals: scopedFullName,
        mode: "insensitive"
      }
    }
  });
  if (!repo) throw new Error(`Repository not found: ${fullName}`);
  return repo;
}

const MAX_IDE_STANDARD_CHARS = 220;
const MAX_IDE_PR_COMMENTS = 200;
const MAX_IDE_OPEN_FINDINGS = 200;
const MAX_IDE_WEEKLY_FEEDBACK_ROWS = 2000;

function normalizeIdeStandardText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_IDE_STANDARD_CHARS).trim();
}

function buildIdeStandardSuggestion(text: string) {
  const normalizedText = normalizeIdeStandardText(text);
  if (!normalizedText) {
    throw new Error("Standard text is required");
  }

  const reason = `memory:${normalizedText.toLowerCase()}`;
  const ruleId = `memory-${crypto.createHash("sha1").update(normalizedText).digest("hex").slice(0, 12)}`;

  return {
    normalizedText,
    reason,
    status: "pending" as const,
    ruleJson: {
      id: ruleId,
      title: `Team preference: ${normalizedText}`.slice(0, 110),
      description: `IDE-added standard pending approval: ${normalizedText}`,
      severity: "important",
      category: "maintainability",
      commentType: "inline" as const,
      strictness: "medium" as const,
      pattern: normalizedText,
      scope: "**/*",
      source: "ide_mcp"
    }
  };
}

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "grepiku-ide",
    version: "1.0.0"
  });
  let activeRepoPromise: Promise<string> | null = null;
  const getActiveRepoPromise = () => {
    activeRepoPromise ||= resolveActiveRepoFullName();
    return activeRepoPromise;
  };

  // -- pr_listComments -------------------------------------------------------
  server.tool(
    "pr_listComments",
    "List all review comments for a pull request",
    toolSchemas.pr_listComments,
    async ({ repo: fullName, prNumber }) => {
      const repo = await resolveRepo(fullName, getActiveRepoPromise());
      const pr = await prisma.pullRequest.findFirst({
        where: { repoId: repo.id, number: prNumber }
      });
      if (!pr) {
        return { content: [{ type: "text", text: `PR #${prNumber} not found in ${fullName}` }] };
      }

      const comments = await prisma.reviewComment.findMany({
        where: { pullRequestId: pr.id },
        take: MAX_IDE_PR_COMMENTS,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          kind: true,
          body: true,
          url: true,
          finding: {
            select: {
              id: true,
              status: true,
              severity: true,
              category: true,
              title: true,
              path: true,
              line: true
            }
          }
        }
      });

      const result = comments.reverse().map((c) => ({
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
      const repo = await resolveRepo(fullName, getActiveRepoPromise());
      const pr = await prisma.pullRequest.findFirst({
        where: { repoId: repo.id, number: prNumber }
      });
      if (!pr) {
        return { content: [{ type: "text", text: `PR #${prNumber} not found in ${fullName}` }] };
      }

      const findings = await prisma.finding.findMany({
        where: { pullRequestId: pr.id, status: "open" },
        take: MAX_IDE_OPEN_FINDINGS,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          path: true,
          line: true,
          severity: true,
          category: true,
          title: true,
          body: true,
          evidence: true,
          suggestedPatch: true,
          ruleId: true
        }
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
    async ({ repo: fullName, findingId }) => {
      const repo = await resolveRepo(fullName, getActiveRepoPromise());
      const finding = await prisma.finding.findFirst({
        where: {
          id: findingId,
          pullRequest: { repoId: repo.id }
        }
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
      const repo = await resolveRepo(fullName, getActiveRepoPromise());
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
        take: 100,
        select: {
          category: true,
          title: true,
          severity: true
        }
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
      const feedbackSummary = await summarizeTrackedTrustedFeedback(feedbackData, {
        repoId: repo.id
      });

      const result = {
        patterns: Array.from(buckets.values()).sort((a, b) => b.count - a.count),
        totalFindings: findings.length,
        totalFeedback: feedbackSummary.totalTrusted
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
      const repo = await resolveRepo(fullName, getActiveRepoPromise());
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
      const repo = await resolveRepo(fullName, getActiveRepoPromise());
      const suggestionInput = buildIdeStandardSuggestion(text);

      // Check for duplicates
      const existing = await prisma.ruleSuggestion.findFirst({
        where: { repoId: repo.id, reason: suggestionInput.reason }
      });
      if (existing) {
        return {
          content: [{ type: "text", text: JSON.stringify({ created: false, reason: "duplicate" }, null, 2) }]
        };
      }

      const suggestion = await prisma.ruleSuggestion.create({
        data: {
          repoId: repo.id,
          status: suggestionInput.status,
          reason: suggestionInput.reason,
          ruleJson: suggestionInput.ruleJson
        }
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ created: true, id: suggestion.id, ruleId: suggestionInput.ruleJson.id, status: suggestionInput.status }, null, 2) }]
      };
    }
  );

  // -- reports_weekly --------------------------------------------------------
  server.tool(
    "reports_weekly",
    "Generate a weekly review report for the last 7 days",
    toolSchemas.reports_weekly,
    async ({ repo: fullName }) => {
      const repo = await resolveRepo(fullName, getActiveRepoPromise());
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const runWhere = {
        pullRequest: { repoId: repo.id },
        createdAt: { gte: since }
      };
      const findingWhere = {
        pullRequest: { repoId: repo.id },
        run: { createdAt: { gte: since } }
      };
      const feedbackWhere = {
        createdAt: { gte: since },
        reviewRun: { pullRequest: { repoId: repo.id } }
      };

      const [
        totalRuns,
        completedRuns,
        failedRuns,
        findingsBySeverityGroups,
        findingsByCategoryGroups,
        feedbackRows
      ] = await Promise.all([
        prisma.reviewRun.count({ where: runWhere }),
        prisma.reviewRun.count({ where: { ...runWhere, status: "completed" } }),
        prisma.reviewRun.count({ where: { ...runWhere, status: "failed" } }),
        prisma.finding.groupBy({
          by: ["severity"],
          where: findingWhere,
          _count: { _all: true }
        }),
        prisma.finding.groupBy({
          by: ["category"],
          where: findingWhere,
          _count: { _all: true }
        }),
        prisma.feedback.findMany({
          where: feedbackWhere,
          orderBy: { createdAt: "desc" },
          take: MAX_IDE_WEEKLY_FEEDBACK_ROWS,
          select: {
            type: true,
            sentiment: true,
            action: true,
            commentId: true,
            metadata: true
          }
        })
      ]);

      const findingsBySeverity: Record<string, number> = {};
      const findingsByCategory: Record<string, number> = {};
      let totalFindings = 0;
      for (const group of findingsBySeverityGroups) {
        findingsBySeverity[group.severity] = group._count._all;
        totalFindings += group._count._all;
      }
      for (const group of findingsByCategoryGroups) {
        findingsByCategory[group.category] = group._count._all;
      }

      const feedbackSummary = await summarizeTrackedTrustedFeedback(feedbackRows, {
        repoId: repo.id
      });

      const result = {
        period: { from: since.toISOString(), to: new Date().toISOString() },
        runs: { total: totalRuns, completed: completedRuns, failed: failedRuns },
        findings: {
          total: totalFindings,
          bySeverity: findingsBySeverity,
          byCategory: findingsByCategory
        },
        feedback: {
          positive: feedbackSummary.positive,
          negative: feedbackSummary.negative,
          trustedCount: feedbackSummary.totalTrusted,
          acceptanceRate: formatAcceptanceRate(feedbackSummary.acceptanceRate)
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

export const __ideServerInternals = {
  assertIdeRepoScope,
  buildIdeStandardSuggestion,
  normalizeIdeStandardText,
  parseGithubRepoFullNameFromRemote,
  resolveConfiguredIdeActiveRepoFullName
};
