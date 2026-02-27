import fs from "fs/promises";
import path from "path";
import { minimatch } from "minimatch";
import { ZodSchema } from "zod";
import { prisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { loadRepoConfig, saveRepoConfig } from "./config.js";
import { createRunDirs, writeBundleFiles } from "./bundle.js";
import {
  buildReviewerPrompt,
  buildEditorPrompt,
  buildVerifierPrompt,
  buildCoverageReviewerPrompt
} from "./prompts.js";
import { CodexStage, runCodexStage } from "../runner/codexRunner.js";
import { parseAndValidateJson, readAndValidateJson } from "./json.js";
import {
  ReviewSchema,
  VerdictsSchema,
  ChecksSchema,
  ReviewComment,
  ReviewCommentSchema,
  ChecksOutput
} from "./schemas.js";
import {
  buildDiffIndex,
  isLineInDiff,
  hunkHashForComment,
  contextHashForComment,
  normalizePath
} from "./diff.js";
import { fingerprintForComment, matchKeyForComment } from "./findings.js";
import { selectSemanticFindingCandidate } from "./findingMatch.js";
import { ReviewOutput } from "./schemas.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderPullRequest, ProviderRepo, ProviderStatusCheck, ProviderReviewComment } from "../providers/types.js";
import { enqueueAnalyticsJob, enqueueIndexJob } from "../queue/enqueue.js";
import { resolveRules } from "./triggers.js";
import { buildContextPack } from "./context.js";
import { getFeedbackPolicy, FeedbackPolicy } from "../services/feedback.js";
import { refineReviewComments } from "./quality.js";
import { buildLocalChangedFiles, buildLocalDiffPatch } from "./localCompare.js";
import { loadAcceptedRepoMemoryRules, mergeRulesWithRepoMemory } from "../services/repoMemory.js";
import {
  buildCoveragePlan,
  mergeSupplementalComments,
  mergeSupplementalSummary
} from "./coverage.js";

const env = loadEnv();

export type ReviewJobData = {
  provider: "github";
  installationId?: string | null;
  repoId: number;
  pullRequestId: number;
  prNumber: number;
  headSha: string;
  trigger: string;
  force?: boolean;
  rulesOverride?: any;
};

 

function filterAndNormalizeComments(
  review: ReviewOutput,
  diffIndex: ReturnType<typeof buildDiffIndex>,
  maxInline: number,
  ignoreGlobs: string[],
  allowedTypes: Array<"inline" | "summary">,
  summaryOnly: boolean,
  strictness: "low" | "medium" | "high",
  feedbackPolicy?: FeedbackPolicy
): { inline: ReviewComment[]; summary: ReviewComment[] } {
  const inline: ReviewComment[] = [];
  const summary: ReviewComment[] = [];
  const seenInline = new Set<string>();
  const seenSummary = new Set<string>();
  const negativeCategories = feedbackPolicy ? new Set(feedbackPolicy.negativeCategories) : null;
  for (const comment of review.comments) {
    if (ignoreGlobs.some((pattern) => minimatch(comment.path, pattern))) continue;
    const evidence = (comment.evidence || "").trim();
    if (evidence.length === 0 || evidence === "\"\"" || evidence === "''") continue;
    const requestedType = comment.comment_type || "inline";
    const type = summaryOnly ? "summary" : requestedType;
    if (type !== "summary" && comment.severity === "blocking" && !comment.suggested_patch) continue;
    if (type !== "summary" && !isLineInDiff(diffIndex, comment)) continue;
    const confidence = comment.confidence || "medium";
    if (strictness === "high") {
      if (comment.severity === "nit") continue;
      if (confidence === "low") continue;
    }
    if (strictness === "medium") {
      if (comment.severity === "nit" && confidence === "low") continue;
    }
    if (negativeCategories?.has(comment.category)) {
      if (comment.severity !== "blocking" && confidence !== "high") continue;
    }
    if (!allowedTypes.includes(type)) continue;
    if (type === "summary") {
      const key = `${comment.category}|${comment.title.toLowerCase()}|${comment.body.toLowerCase()}`;
      if (seenSummary.has(key)) continue;
      seenSummary.add(key);
      summary.push(comment);
      continue;
    }
    if (!summaryOnly) {
      const key = `${normalizePath(comment.path)}|${comment.side}|${comment.line}|${comment.title.toLowerCase()}`;
      if (seenInline.has(key)) continue;
      seenInline.add(key);
      inline.push(comment);
      if (inline.length >= maxInline) break;
    }
  }
  return { inline, summary };
}

function normalizeFindingTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function semanticFindingKey(pathValue: string, category: string, title: string): string {
  return `${normalizePath(pathValue)}|${category}|${normalizeFindingTitle(title)}`;
}

function buildFeedbackHint(policy: FeedbackPolicy): string {
  const lines: string[] = [];
  if (policy.negativeCategories.length > 0) {
    lines.push(
      `- Be extra strict for categories often rejected: ${policy.negativeCategories.join(", ")}.`
    );
  }
  if (policy.positiveCategories.length > 0) {
    lines.push(
      `- Give extra attention to categories often accepted: ${policy.positiveCategories.join(", ")}.`
    );
  }
  if (lines.length === 0) return "";
  return `\n\nFeedback guidance:\n${lines.join("\n")}`;
}

function formatInlineComment(comment: ReviewComment): string {
  const marker = `<!-- grepiku:${comment.comment_id} -->`;
  const normalizeSuggestedPatch = (patch: string) => {
    let normalized = patch.replace(/\\n/g, "\n");
    normalized = normalized
      .replace(/^```(?:suggestion|diff)?\n?/i, "")
      .replace(/```$/, "")
      .trim();
    const lines = normalized.split("\n");
    const hasDiffMarkers = lines.some(
      (line) =>
        line.startsWith("diff") ||
        line.startsWith("@@") ||
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("+") ||
        line.startsWith("-")
    );
    if (hasDiffMarkers) {
      const kept: string[] = [];
      for (const line of lines) {
        if (
          line.startsWith("diff") ||
          line.startsWith("@@") ||
          line.startsWith("+++ ") ||
          line.startsWith("--- ")
        ) {
          continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
          kept.push(line.slice(1));
          continue;
        }
        if (line.startsWith(" ")) {
          kept.push(line.slice(1));
          continue;
        }
        if (!line.startsWith("-")) {
          kept.push(line);
        }
      }
      if (kept.length > 0) {
        normalized = kept.join("\n");
      }
    }
    return normalized.trimEnd();
  };
  const bodyParts = [
    marker,
    `**${comment.severity.toUpperCase()}** ${comment.title}`,
    `Category: ${comment.category}`,
    comment.rule_id ? `Rule: ${comment.rule_id}` : null,
    comment.body
  ].filter((line) => line !== null);

  const suggestedPatch = comment.suggested_patch
    ? normalizeSuggestedPatch(comment.suggested_patch)
    : null;

  if (suggestedPatch) {
    bodyParts.push("Suggested change:", "```suggestion", suggestedPatch, "```");
  }

  return bodyParts.join("\n\n");
}

function extractCommentId(body: string): string | null {
  const match = body.match(/<!--\s*grepiku:([^\s]+)\s*-->/);
  return match ? match[1] : null;
}

function renderStatusComment(params: {
  summary: ReviewOutput["summary"];
  newFindings: Array<{ title: string; url?: string }>;
  openFindings: Array<{ title: string; url?: string }>;
  fixedFindings: Array<{ title: string }>;
  run?: {
    id: number;
    headSha: string;
  };
  checks: {
    lint: { status: string; summary: string; top_errors: string[] };
    build: { status: string; summary: string; top_errors: string[] };
    test: { status: string; summary: string; top_errors: string[] };
  };
  warnings?: string[];
}): string {
  const { summary, newFindings, openFindings, fixedFindings, checks, warnings } = params;
  const renderList = (items: Array<{ title: string; url?: string }>) => {
    if (items.length === 0) return "- (none)";
    return items.map((item) => (item.url ? `- [${item.title}](${item.url})` : `- ${item.title}`)).join("\n");
  };

  const renderFixed = () => {
    if (fixedFindings.length === 0) return "- (none)";
    return fixedFindings.map((item) => `- ${item.title}`).join("\n");
  };

  const renderCheck = (name: string, result: { status: string; summary: string; top_errors: string[] }) => {
    const errors = result.top_errors.length ? result.top_errors.map((e) => `  - ${e}`).join("\n") : "  - (none)";
    return `**${name}**: ${result.status} - ${result.summary}\n${errors}`;
  };

  return [
    "## AI Review Status",
    "",
    `**Overview:** ${summary.overview}`,
    `**Risk:** ${summary.risk}`,
    summary.confidence !== undefined ? `**Confidence:** ${(summary.confidence * 100).toFixed(0)}%` : "",
    params.run ? `**Run:** #${params.run.id} (\`${params.run.headSha.slice(0, 12)}\`)` : "",
    "",
    "### New Findings",
    renderList(newFindings),
    "",
    "### Open Findings",
    renderList(openFindings),
    "",
    "### Fixed Findings",
    renderFixed(),
    "",
    warnings && warnings.length > 0 ? "### Config Warnings\n" + warnings.map((w) => `- ${w}`).join("\n") : "",
    "",
    "### Checks",
    renderCheck("lint", checks.lint),
    "",
    renderCheck("build", checks.build),
    "",
    renderCheck("test", checks.test)
  ].join("\n");
}

function renderReviewingComment(): string {
  return [
    "## AI Review Status",
    "",
    "Review in progress. Grepiku is analyzing the PR and will update this comment when done."
  ].join("\n");
}

async function upsertStatusComment(params: {
  client: {
    createSummaryComment: (body: string) => Promise<{ id: string; body: string; url?: string | null }>;
    updateSummaryComment: (commentId: string, body: string) => Promise<{ id: string; body: string; url?: string | null }>;
  };
  pullRequestId: number;
  body: string;
}): Promise<{ action: "created" | "updated"; commentId: string; url?: string | null }> {
  const { client, pullRequestId, body } = params;
  const statusComment = await prisma.reviewComment.findFirst({
    where: { pullRequestId, kind: "summary" }
  });

  if (statusComment) {
    try {
      const updated = await client.updateSummaryComment(statusComment.providerCommentId, body);
      await prisma.reviewComment.update({
        where: { id: statusComment.id },
        data: { body, url: updated.url || statusComment.url || null }
      });
      return { action: "updated", commentId: updated.id, url: updated.url || null };
    } catch (err: unknown) {
      await prisma.reviewComment.delete({ where: { id: statusComment.id } }).catch(() => undefined);
    }
  }

  const created = await client.createSummaryComment(body);
  await prisma.reviewComment.create({
    data: {
      pullRequestId,
      kind: "summary",
      providerCommentId: created.id,
      body: created.body,
      url: created.url || null
    }
  });
  return { action: "created", commentId: created.id, url: created.url || null };
}

function buildFixPrompt(comments: ReviewComment[]): string {
  if (comments.length === 0) {
    return [
      "There are no review findings to fix.",
      "If you made changes, ensure tests and lint still pass."
    ].join("\n");
  }

  const normalizeMultiline = (value: string) =>
    value
      .replace(/\r\n/g, "\n")
      .replace(/\\n/g, "\n")
      .trimEnd();

  const normalizeSuggestedPatch = (patch: string) => {
    let normalized = patch.replace(/\\n/g, "\n");
    normalized = normalized
      .replace(/^```(?:suggestion|diff)?\n?/i, "")
      .replace(/```$/, "")
      .trim();
    const lines = normalized.split("\n");
    const hasDiffMarkers = lines.some(
      (line) =>
        line.startsWith("diff") ||
        line.startsWith("@@") ||
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("+") ||
        line.startsWith("-")
    );
    if (hasDiffMarkers) {
      const added = lines
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1));
      if (added.length > 0) {
        normalized = added.join("\n");
      } else {
        const kept = lines.filter(
          (line) =>
            !line.startsWith("-") &&
            !line.startsWith("@@") &&
            !line.startsWith("diff") &&
            !line.startsWith("+++ ") &&
            !line.startsWith("--- ")
        );
        if (kept.length > 0) {
          normalized = kept.join("\n");
        }
      }
    }
    return normalized.trimEnd();
  };

  const lines: string[] = [];
  lines.push("You are an AI coding assistant.");
  lines.push("Fix all issues listed below in this PR.");
  lines.push("Follow the project conventions and keep changes minimal.");
  lines.push("After fixes, update or add tests when appropriate.");
  lines.push("");
  lines.push("Issues:");
  comments.forEach((comment, idx) => {
    lines.push(
      `${idx + 1}. [${comment.severity}] ${comment.path}:${comment.line} (${comment.side}) - ${comment.title}`
    );
    lines.push(`Category: ${comment.category}`);
    lines.push("Evidence:");
    const evidence = normalizeMultiline(comment.evidence);
    if (evidence) {
      lines.push(...evidence.split("\n"));
    } else {
      lines.push("(none)");
    }
    const details = normalizeMultiline(comment.body);
    if (details.includes("\n")) {
      lines.push("Details:");
      lines.push(...details.split("\n"));
    } else {
      lines.push(`Details: ${details}`);
    }
    if (comment.suggested_patch) {
      lines.push("Suggested patch:");
      const patch = normalizeMultiline(normalizeSuggestedPatch(comment.suggested_patch));
      if (patch) {
        lines.push(...patch.split("\n"));
      }
    }
    lines.push("");
  });

  return lines.join("\n");
}

function buildSummaryBlock(
  summary: ReviewOutput["summary"],
  comments: ReviewComment[],
  summaryComments: ReviewComment[],
  patternMatches: string[]
): string {
  const start = "<!-- grepiku-summary:start -->";
  const end = "<!-- grepiku-summary:end -->";
  const severityOrder = { blocking: 0, important: 1, nit: 2 } as const;
  const notable = [...comments].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  )[0];
  const keyConcerns =
    summary.key_concerns.length > 0
      ? summary.key_concerns.map((c) => `- ${c}`).join("\n")
      : "- (none)";
  const whatToTest =
    summary.what_to_test.length > 0
      ? summary.what_to_test.map((c) => `- ${c}`).join("\n")
      : "- (none)";

  const notableLine = notable
    ? `Notable issue: ${notable.title} (${notable.severity})`
    : "Notable issue: (none)";

  const fileBreakdown =
    summary.file_breakdown?.length
      ? summary.file_breakdown
          .map((file) => `- ${file.path}: ${file.summary}${file.risk ? ` (risk: ${file.risk})` : ""}`)
          .join("\n")
      : "- (none)";

  const summaryFindings =
    summaryComments.length > 0
      ? summaryComments.map((c) => `- ${c.title}: ${c.body}`).join("\n")
      : "- (none)";

  const patternBlock =
    patternMatches.length > 0
      ? patternMatches.map((match) => `- ${match}`).join("\n")
      : "- (none)";
  const fixPrompt =
    comments.length > 0
      ? buildFixPrompt(comments)
      : [
          "There are no review findings to fix.",
          "If you made changes, ensure tests and lint still pass."
        ].join("\n");
  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const fixBlock = [
    "<details>",
    "<summary>Fix with AI</summary>",
    "",
    "<pre><code>",
    escapeHtml(fixPrompt),
    "</code></pre>",
    "</details>"
  ].join("\n");

  const summaryLines = [
    summary.overview,
    `Risk: ${summary.risk}`,
    summary.confidence !== undefined ? `Confidence: ${(summary.confidence * 100).toFixed(0)}%` : null,
    notableLine
  ]
    .filter((line): line is string => Boolean(line))
    .map((line) => `${line}  `);

  return [
    start,
    "## Grepiku Summary",
    "",
    fixBlock,
    "",
    ...summaryLines,
    "",
    "File breakdown:",
    fileBreakdown,
    "",
    "Summary findings:",
    summaryFindings,
    "",
    "Pattern matches:",
    patternBlock,
    "",
    "Key concerns:",
    keyConcerns,
    "",
    "What to test:",
    whatToTest,
    summary.diagram_mermaid ? "" : "",
    summary.diagram_mermaid ? "Diagram:" : "",
    summary.diagram_mermaid ? "```mermaid" : "",
    summary.diagram_mermaid || "",
    summary.diagram_mermaid ? "```" : "",
    end
  ].filter((line) => line !== null).join("\n");
}

function computeConfidence(summary: ReviewOutput["summary"], comments: ReviewComment[]): number {
  if (summary.confidence !== undefined) return summary.confidence;
  const blocking = comments.filter((c) => c.severity === "blocking").length;
  const important = comments.filter((c) => c.severity === "important").length;
  const nit = comments.filter((c) => c.severity === "nit").length;
  const penalty = blocking * 0.18 + important * 0.08 + nit * 0.02;
  const base = summary.risk === "high" ? 0.45 : summary.risk === "medium" ? 0.6 : 0.75;
  return Math.max(0.2, Math.min(0.95, base - penalty));
}

function sanitizeMermaidLabel(label: string): string {
  return label
    .replace(/["<>]/g, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

function makeMermaidNodeId(path: string, index: number): string {
  const slug = path
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
  return `p_${slug || "node"}_${index}`;
}

function generateMermaidDiagram(params: {
  changedFiles: Array<{ filename?: string; path?: string }>;
  relatedFiles: string[];
  graphLinks: Array<{ from: string; to: string; type: string }>;
}): string {
  const changedFiles = params.changedFiles;
  const relatedFiles = params.relatedFiles;
  const changed = changedFiles
    .map((file) => file.filename || file.path)
    .filter((value): value is string => Boolean(value));
  if (changed.length === 0) return "";

  const maxNodes = 28;
  const maxEdges = 42;
  const changedSlice = changed.slice(0, 12);
  const relatedSlice = relatedFiles.slice(0, 18);
  const scopeSet = new Set([...changedSlice, ...relatedSlice]);

  const nodeIds = new Map<string, string>();
  const edges: Array<{ from: string; to: string }> = [];
  const dedupe = new Set<string>();

  for (const link of params.graphLinks) {
    if (link.type !== "file_dep") continue;
    if (link.from === link.to) continue;
    if (!scopeSet.has(link.from) && !scopeSet.has(link.to)) continue;
    const key = `${link.from}->${link.to}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    edges.push({ from: link.from, to: link.to });
    if (edges.length >= maxEdges) break;
  }

  if (edges.length === 0) {
    for (const from of changedSlice) {
      for (const to of relatedSlice) {
        if (from === to) continue;
        const key = `${from}->${to}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        edges.push({ from, to });
        if (edges.length >= Math.min(maxEdges, 16)) break;
      }
      if (edges.length >= Math.min(maxEdges, 16)) break;
    }
  }
  if (edges.length === 0) return "";

  const nodeOrder: string[] = [];
  const addNode = (path: string) => {
    if (nodeIds.has(path)) return;
    const idx = nodeIds.size;
    nodeIds.set(path, makeMermaidNodeId(path, idx));
    nodeOrder.push(path);
  };

  for (const path of changedSlice) addNode(path);
  for (const edge of edges) {
    addNode(edge.from);
    addNode(edge.to);
    if (nodeOrder.length >= maxNodes) break;
  }

  const allowed = new Set(nodeOrder.slice(0, maxNodes));
  const filteredEdges = edges
    .filter((edge) => allowed.has(edge.from) && allowed.has(edge.to))
    .slice(0, maxEdges);
  if (filteredEdges.length === 0) return "";

  const finalNodes = nodeOrder.filter((path) => allowed.has(path));
  finalNodes.forEach((path, idx) => {
    if (!nodeIds.has(path)) {
      nodeIds.set(path, makeMermaidNodeId(path, idx));
    }
  });

  const changedSet = new Set(changedSlice);
  const nodeLines = finalNodes.map((path) => {
    const id = nodeIds.get(path);
    const label = sanitizeMermaidLabel(path);
    return `${id}["${label}"]`;
  });

  const edgeLines = filteredEdges
    .map((edge) => {
      const fromId = nodeIds.get(edge.from);
      const toId = nodeIds.get(edge.to);
      if (!fromId || !toId) return null;
      return `${fromId} --> ${toId}`;
    })
    .filter((line): line is string => Boolean(line));

  const classLines = finalNodes
    .filter((path) => changedSet.has(path))
    .map((path) => {
      const id = nodeIds.get(path);
      return id ? `class ${id} changed;` : null;
    })
    .filter((line): line is string => Boolean(line));

  return [
    "graph TD",
    ...nodeLines,
    ...edgeLines,
    "classDef changed fill:#ffd7ba,stroke:#c2410c,stroke-width:1px,color:#111;",
    ...classLines
  ].join("\n");
}

function enrichSummary(params: {
  summary: ReviewOutput["summary"];
  comments: ReviewComment[];
  changedFiles: Array<{ filename?: string; path?: string }>;
  relatedFiles: string[];
  graphLinks: Array<{ from: string; to: string; type: string }>;
}): ReviewOutput["summary"] {
  const summary = { ...params.summary };
  if (!summary.file_breakdown || summary.file_breakdown.length === 0) {
    const counts = new Map<string, number>();
    for (const comment of params.comments) {
      counts.set(comment.path, (counts.get(comment.path) || 0) + 1);
    }
    summary.file_breakdown = params.changedFiles
      .map((file) => file.filename || file.path)
      .filter((value): value is string => Boolean(value))
      .map((path) => ({
        path,
        summary: counts.get(path) ? `${counts.get(path)} review comment(s)` : "No major issues"
      }));
  }
  if (!summary.diagram_mermaid) {
    const diagram = generateMermaidDiagram({
      changedFiles: params.changedFiles,
      relatedFiles: params.relatedFiles,
      graphLinks: params.graphLinks
    });
    if (diagram) summary.diagram_mermaid = diagram;
  }
  if (summary.confidence === undefined) {
    summary.confidence = computeConfidence(summary, params.comments);
  }
  return summary;
}

function upsertSummaryBlock(body: string, block: string): string {
  const start = "<!-- grepiku-summary:start -->";
  const end = "<!-- grepiku-summary:end -->";
  const startIdx = body.indexOf(start);
  const endIdx = body.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = body.slice(0, startIdx).trimEnd();
    const after = body.slice(endIdx + end.length).trimStart();
    return [before, block, after].filter((part) => part.length > 0).join("\n\n");
  }
  const trimmed = body.trim();
  if (trimmed.length === 0) return block;
  return `${trimmed}\n\n${block}`;
}

function renderPrMarkdown(params: {
  title: string;
  number: number;
  author: string;
  body?: string | null;
  baseRef?: string | null;
  headRef?: string | null;
  headSha: string;
  url?: string | null;
}): string {
  const { title, number, author, body, baseRef, headRef, headSha, url } = params;
  return `# PR #${number}: ${title}

Author: ${author}
Base: ${baseRef || ""}
Head: ${headRef || ""}
Head SHA: ${headSha}
URL: ${url || ""}

## Description
${body || "(no description)"}
`;
}

async function readJsonWithFallback<T>(
  filePath: string,
  schema: ZodSchema<T>,
  stage: CodexStage
): Promise<T> {
  try {
    return await readAndValidateJson(filePath, schema);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    const fallbackPath = path.join(path.dirname(filePath), `last_message_${stage}.txt`);
    const raw = await fs.readFile(fallbackPath, "utf8");
    return parseAndValidateJson(raw, schema);
  }
}

export async function processReviewJob(data: ReviewJobData) {
  const { provider, installationId, repoId, pullRequestId, prNumber, headSha, trigger, rulesOverride } = data;
  const repo = await prisma.repo.findFirst({ where: { id: repoId } });
  const pullRequestRecord = await prisma.pullRequest.findFirst({ where: { id: pullRequestId } });
  if (!repo || !pullRequestRecord) return;

  const installation = installationId
    ? await prisma.installation.findFirst({ where: { externalId: installationId } })
    : null;

  const adapter = getProviderAdapter(provider);
  const providerRepo: ProviderRepo = {
    externalId: repo.externalId,
    owner: repo.owner,
    name: repo.name,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch || undefined
  };
  const providerPull: ProviderPullRequest = {
    externalId: pullRequestRecord.externalId,
    number: prNumber,
    title: pullRequestRecord.title || null,
    body: pullRequestRecord.body || null,
    url: pullRequestRecord.url || null,
    state: pullRequestRecord.state,
    baseRef: pullRequestRecord.baseRef || null,
    headRef: pullRequestRecord.headRef || null,
    baseSha: pullRequestRecord.baseSha || null,
    headSha: headSha || pullRequestRecord.headSha
  };
  let client = await adapter.createClient({
    installationId: installationId || null,
    repo: providerRepo,
    pullRequest: providerPull
  });
  const refreshed = await client.fetchPullRequest();
  client = await adapter.createClient({
    installationId: installationId || null,
    repo: providerRepo,
    pullRequest: refreshed
  });

  const authorUser = refreshed.author
    ? await prisma.user.upsert({
        where: { providerId_externalId: { providerId: repo.providerId, externalId: refreshed.author.externalId } },
        update: {
          login: refreshed.author.login,
          name: refreshed.author.name || null,
          avatarUrl: refreshed.author.avatarUrl || null
        },
        create: {
          providerId: repo.providerId,
          externalId: refreshed.author.externalId,
          login: refreshed.author.login,
          name: refreshed.author.name || null,
          avatarUrl: refreshed.author.avatarUrl || null
        }
      })
    : null;

  const pullRequest = await prisma.pullRequest.update({
    where: { id: pullRequestRecord.id },
    data: {
      title: refreshed.title || pullRequestRecord.title,
      body: refreshed.body || pullRequestRecord.body,
      url: refreshed.url || pullRequestRecord.url,
      state: refreshed.state,
      baseRef: refreshed.baseRef || pullRequestRecord.baseRef,
      headRef: refreshed.headRef || pullRequestRecord.headRef,
      baseSha: refreshed.baseSha || pullRequestRecord.baseSha,
      headSha: refreshed.headSha,
      draft: refreshed.draft ?? pullRequestRecord.draft,
      authorId: authorUser?.id || pullRequestRecord.authorId
    }
  });

  const run = await prisma.reviewRun.create({
    data: {
      pullRequestId: pullRequest.id,
      installationId: installation?.id || null,
      headSha: refreshed.headSha,
      status: "running",
      startedAt: new Date(),
      trigger
    }
  });

  let statusCheckRecord: ProviderStatusCheck | null = null;
  let statusCheckRowId: number | null = null;

  try {
    const repoPath = await client.ensureRepoCheckout({ headSha: refreshed.headSha });

    const latestCompletedRun = await prisma.reviewRun.findFirst({
      where: {
        pullRequestId: pullRequest.id,
        status: "completed"
      },
      orderBy: { createdAt: "desc" }
    });
    const previousRun = await prisma.reviewRun.findFirst({
      where: {
        pullRequestId: pullRequest.id,
        status: "completed",
        headSha: { not: refreshed.headSha }
      },
      orderBy: { createdAt: "desc" }
    });
    const incrementalFrom = previousRun?.headSha || null;
    const incrementalReview = Boolean(incrementalFrom) && !data.force && trigger !== "manual";
    const fullRepoStaticAudit = !latestCompletedRun;

    const { config: fileRepoConfig, warnings } = await loadRepoConfig(repoPath);
    await saveRepoConfig(repo.id, fileRepoConfig, warnings);
    const memoryRules = await loadAcceptedRepoMemoryRules(repo.id);
    const repoConfig =
      memoryRules.length > 0
        ? { ...fileRepoConfig, rules: mergeRulesWithRepoMemory(fileRepoConfig.rules, memoryRules) }
        : fileRepoConfig;
    const resolvedConfig = resolveRules(repoConfig, {
      orgDefaults: (installation?.configJson as any) || undefined,
      uiRules: rulesOverride?.rules || [],
      strictness: rulesOverride?.strictness,
      commentTypes: rulesOverride?.commentTypes,
      output: rulesOverride?.output,
      triggers: rulesOverride?.triggers
    });
    try {
      statusCheckRecord = await client.createStatusCheck({
        name: resolvedConfig.statusChecks.name,
        status: "in_progress",
        summary: "Review in progress"
      });
      const row = await prisma.statusCheck.create({
        data: {
          reviewRunId: run.id,
          name: statusCheckRecord.name,
          status: "in_progress",
          providerCheckId: statusCheckRecord.id || null,
          outputJson: {
            summary: statusCheckRecord.summary,
            required: resolvedConfig.statusChecks.required
          }
        }
      });
      statusCheckRowId = row.id;
    } catch (err) {
      console.warn(`[run ${run.id} pr#${prNumber}] unable to create check-run; continuing without status checks`, {
        error: err instanceof Error ? err.message : String(err)
      });
      statusCheckRecord = null;
    }
    if (resolvedConfig.output.destination === "comment" || resolvedConfig.output.destination === "both") {
      const initialStatus = await upsertStatusComment({
        client,
        pullRequestId: pullRequest.id,
        body: renderReviewingComment()
      });
      console.log(
        `[run ${run.id} pr#${prNumber}] status comment ${initialStatus.action}: ${initialStatus.url || initialStatus.commentId}`
      );
    }

    for (const patternRepo of resolvedConfig.patternRepositories) {
      const pattern = await prisma.patternRepository.upsert({
        where: { url: patternRepo.url },
        update: { name: patternRepo.name, ref: patternRepo.ref || null },
        create: { name: patternRepo.name, url: patternRepo.url, ref: patternRepo.ref || null }
      });
      await prisma.patternRepositoryLink.upsert({
        where: { repoId_patternRepoId: { repoId: repo.id, patternRepoId: pattern.id } },
        update: { scope: patternRepo.scope || null },
        create: { repoId: repo.id, patternRepoId: pattern.id, scope: patternRepo.scope || null }
      });
      await enqueueIndexJob({
        provider,
        installationId: installationId || null,
        repoId: repo.id,
        headSha: refreshed.headSha,
        patternRepo: { url: patternRepo.url, ref: patternRepo.ref, name: patternRepo.name }
      });
    }

    let diffPatch = "";
    let changedFiles: Array<{ path?: string; status?: string; additions?: number; deletions?: number; patch?: string | null }>;
    changedFiles = [];
    const comparisonBaseSha = incrementalReview && incrementalFrom ? incrementalFrom : refreshed.baseSha;
    let localCompareSucceeded = false;

    if (comparisonBaseSha) {
      try {
        diffPatch = await buildLocalDiffPatch({
          repoPath,
          baseSha: comparisonBaseSha,
          headSha: refreshed.headSha
        });
        changedFiles = await buildLocalChangedFiles({
          repoPath,
          baseSha: comparisonBaseSha,
          headSha: refreshed.headSha
        });
        localCompareSucceeded = true;
        console.log(
          `[run ${run.id} pr#${prNumber}] using local git compare (${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"})`
        );
      } catch (err) {
        console.warn(`[run ${run.id} pr#${prNumber}] local git compare failed; falling back to provider API`, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    if (!localCompareSucceeded) {
      try {
        diffPatch = await client.fetchDiffPatch();
      } catch {
        diffPatch = await buildLocalDiffPatch({
          repoPath,
          baseSha: refreshed.baseSha,
          headSha: refreshed.headSha
        });
      }
      changedFiles = await client.listChangedFiles();
    }

    const prMarkdown = renderPrMarkdown({
      title: refreshed.title || pullRequest.title || "Untitled",
      number: prNumber,
      author: refreshed.author?.login || "unknown",
      body: refreshed.body,
      baseRef: refreshed.baseRef,
      headRef: refreshed.headRef,
      headSha: refreshed.headSha,
      url: refreshed.url
    });

    const contextPack = await buildContextPack({
      repoId: repo.id,
      diffPatch,
      changedFiles: changedFiles as Array<{
        filename?: string;
        path?: string;
        status?: string;
        additions?: number;
        deletions?: number;
      }>,
      prTitle: refreshed.title || pullRequest.title,
      prBody: refreshed.body || pullRequest.body,
      retrieval: resolvedConfig.retrieval,
      graph: resolvedConfig.graph
    });

    const { bundleDir, outDir, codexHomeDir } = await createRunDirs(env.projectRoot, run.id);
    await writeBundleFiles({
      bundleDir,
      prMarkdown,
      diffPatch,
      changedFiles,
      repoConfig,
      resolvedConfig,
      contextPack,
      warnings
    });

    const promptPaths = {
      repoPath,
      bundleDir,
      outDir
    };

    const checksPrompt = buildVerifierPrompt(refreshed.headSha, promptPaths);
    const verifierPromise = runCodexStage({
      stage: "verifier",
      repoPath,
      bundleDir,
      outDir,
      codexHomeDir,
      prompt: checksPrompt,
      headSha: refreshed.headSha,
      repoId: repo.id,
      reviewRunId: run.id,
      prNumber,
      captureLastMessage: false
    })
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    const feedbackPolicy = await getFeedbackPolicy(repo.id);
    const incrementalHint =
      incrementalReview && incrementalFrom
        ? `\n\nReview only code changes between ${incrementalFrom} and ${refreshed.headSha}. Treat this as a full review of the update and do not mention that this run is incremental.`
        : "";
    const reviewerPrompt =
      buildReviewerPrompt(resolvedConfig, promptPaths, { fullRepoStaticAudit }) +
      buildFeedbackHint(feedbackPolicy) +
      incrementalHint;
    await runCodexStage({
      stage: "reviewer",
      repoPath,
      bundleDir,
      outDir,
      codexHomeDir,
      prompt: reviewerPrompt,
      headSha: refreshed.headSha,
      repoId: repo.id,
      reviewRunId: run.id,
      prNumber
    });

    const draft = await readJsonWithFallback(
      path.join(outDir, "draft_review.json"),
      ReviewSchema,
      "reviewer"
    );

    const editorPrompt = buildEditorPrompt(JSON.stringify(draft, null, 2), promptPaths, { fullRepoStaticAudit });
    await runCodexStage({
      stage: "editor",
      repoPath,
      bundleDir,
      outDir,
      codexHomeDir,
      prompt: editorPrompt,
      headSha: refreshed.headSha,
      repoId: repo.id,
      reviewRunId: run.id,
      prNumber
    });

    const finalReview = await readJsonWithFallback(
      path.join(outDir, "final_review.json"),
      ReviewSchema,
      "editor"
    );
    const verdicts = await readJsonWithFallback(
      path.join(outDir, "verdicts.json"),
      VerdictsSchema,
      "editor"
    );

    const diffIndex = buildDiffIndex(diffPatch);
    const verdictMap = new Map(verdicts.verdicts.map((v) => [v.comment_id, v]));
    let commentsAfterVerdict: ReviewComment[] = [];
    for (const comment of finalReview.comments) {
      const verdict = verdictMap.get(comment.comment_id);
      if (verdict?.decision === "drop") continue;
      if (verdict?.decision === "revise" && verdict.revised_comment) {
        const revised = ReviewCommentSchema.safeParse(verdict.revised_comment);
        if (revised.success) {
          commentsAfterVerdict.push(revised.data);
          continue;
        }
      }
      commentsAfterVerdict.push(comment);
    }

    const coveragePlan = buildCoveragePlan({
      changedFiles: changedFiles as Array<{
        path?: string;
        filename?: string;
        additions?: number;
        deletions?: number;
      }>,
      changedFileStats: contextPack.changedFileStats,
      comments: commentsAfterVerdict,
      maxTargets: Math.min(12, Math.max(4, Math.ceil(resolvedConfig.limits.max_inline_comments * 0.5)))
    });
    const coverageDiagnostics = {
      attempted: false,
      targets: coveragePlan.targets.length,
      added: 0,
      droppedDuplicates: 0,
      droppedLowValue: 0
    };
    const shouldRunCoveragePass =
      coveragePlan.shouldRun &&
      coveragePlan.targets.length > 0 &&
      !resolvedConfig.output.summaryOnly &&
      resolvedConfig.commentTypes.allow.includes("inline") &&
      commentsAfterVerdict.length < resolvedConfig.limits.max_inline_comments;

    if (shouldRunCoveragePass) {
      coverageDiagnostics.attempted = true;
      try {
        const coveragePrompt = buildCoverageReviewerPrompt({
          config: resolvedConfig,
          paths: promptPaths,
          existingFindings: commentsAfterVerdict
            .slice(0, 120)
            .map((comment) => ({
              path: comment.path,
              line: comment.line,
              severity: comment.severity,
              category: comment.category,
              title: comment.title
            })),
          targets: coveragePlan.targets
        });
        await runCodexStage({
          stage: "reviewer",
          repoPath,
          bundleDir,
          outDir,
          codexHomeDir,
          prompt: coveragePrompt,
          headSha: refreshed.headSha,
          repoId: repo.id,
          reviewRunId: run.id,
          prNumber
        });

        const coverageDraft = await readJsonWithFallback(
          path.join(outDir, "coverage_draft_review.json"),
          ReviewSchema,
          "reviewer"
        );
        const merged = mergeSupplementalComments({
          base: commentsAfterVerdict,
          supplemental: coverageDraft.comments
        });
        commentsAfterVerdict = merged.comments;
        coverageDiagnostics.added = merged.added;
        coverageDiagnostics.droppedDuplicates = merged.droppedDuplicates;
        coverageDiagnostics.droppedLowValue = merged.droppedLowValue;
        if (merged.added > 0) {
          finalReview.summary = mergeSupplementalSummary({
            base: finalReview.summary,
            supplemental: coverageDraft.summary,
            maxKeyConcerns: resolvedConfig.limits.max_key_concerns
          });
        }
      } catch (err) {
        console.warn(`[run ${run.id} pr#${prNumber}] coverage pass failed; continuing with primary review`, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const qualityRefinement = refineReviewComments({
      comments: commentsAfterVerdict,
      diffIndex,
      changedFiles: changedFiles as Array<{ filename?: string; path?: string }>,
      maxInlineComments: resolvedConfig.limits.max_inline_comments,
      summaryOnly: resolvedConfig.output.summaryOnly,
      allowedTypes: resolvedConfig.commentTypes.allow,
      feedbackPolicy
    });
    finalReview.comments = qualityRefinement.comments;

    finalReview.summary = enrichSummary({
      summary: finalReview.summary,
      comments: finalReview.comments,
      changedFiles: changedFiles as Array<{ filename?: string; path?: string }>,
      relatedFiles: contextPack.relatedFiles,
      graphLinks: contextPack.graphLinks
    });

    const filteredComments = filterAndNormalizeComments(
      finalReview,
      diffIndex,
      resolvedConfig.limits.max_inline_comments,
      resolvedConfig.ignore,
      resolvedConfig.commentTypes.allow,
      resolvedConfig.output.summaryOnly,
      resolvedConfig.strictness,
      feedbackPolicy
    );
    const hasBlocking = filteredComments.inline.some((comment) => comment.severity === "blocking");

    const inlineContext = {
      head_sha: refreshed.headSha,
      summary: finalReview.summary,
      comments: filteredComments.inline
    };
    await fs.writeFile(
      path.join(outDir, "inline_findings.json"),
      JSON.stringify(inlineContext, null, 2),
      "utf8"
    );

    const patternMatches = contextPack.retrieved
      .filter((item) => item.isPattern)
      .map((item) => item.symbol || item.path || "pattern match");
    const summaryBlock = buildSummaryBlock(
      finalReview.summary,
      filteredComments.inline,
      filteredComments.summary,
      patternMatches
    );
    const originalBody = pullRequest.body || "";
    const updatedBody = upsertSummaryBlock(originalBody, summaryBlock);
    const shouldUpdateBody =
      resolvedConfig.output.destination === "pr_body" ||
      resolvedConfig.output.destination === "both" ||
      originalBody.trim().length === 0;
    const allowBodyUpdate = !incrementalReview;
    if (shouldUpdateBody && allowBodyUpdate && updatedBody !== originalBody) {
      try {
        await client.updatePullRequestBody(updatedBody);
      } catch (err) {
        console.warn("Failed to update PR body summary block", err);
      }
    }

    const verifierResult = await verifierPromise;
    if (!verifierResult.ok) {
      throw verifierResult.error;
    }
    const checksPath = path.join(outDir, "checks.json");
    const checks: ChecksOutput = await readAndValidateJson(checksPath, ChecksSchema);

    const existingOpen = await prisma.finding.findMany({
      where: { pullRequestId: pullRequest.id, status: "open" }
    });

    const existingByKey = new Map<string, typeof existingOpen[number]>();
    const existingByHunkCategory = new Map<string, Array<typeof existingOpen[number]>>();
    const existingByPathCategory = new Map<string, Array<typeof existingOpen[number]>>();
    const existingBySemanticTitle = new Map<string, Array<typeof existingOpen[number]>>();
    for (const finding of existingOpen) {
      const key = `${finding.fingerprint}|${finding.path}|${finding.hunkHash}|${finding.title}`;
      existingByKey.set(key, finding);
      const fallbackKey = `${normalizePath(finding.path)}|${finding.hunkHash}|${finding.category}`;
      const bucket = existingByHunkCategory.get(fallbackKey) || [];
      bucket.push(finding);
      existingByHunkCategory.set(fallbackKey, bucket);
      const semanticKey = `${normalizePath(finding.path)}|${finding.category}`;
      const semanticBucket = existingByPathCategory.get(semanticKey) || [];
      semanticBucket.push(finding);
      existingByPathCategory.set(semanticKey, semanticBucket);
      const semanticTitleKey = semanticFindingKey(finding.path, finding.category, finding.title);
      const semanticTitleBucket = existingBySemanticTitle.get(semanticTitleKey) || [];
      semanticTitleBucket.push(finding);
      existingBySemanticTitle.set(semanticTitleKey, semanticTitleBucket);
    }

    const newFindings: Array<{ title: string; url?: string; commentId: string; path: string; category: string }> = [];
    const newFindingIds = new Map<string, number>();
    const stillOpen: Array<{ title: string; url?: string; commentId: string; path: string; category: string }> = [];
    const matchedOldIds = new Set<number>();

    const selectSemanticMatch = (comment: ReviewComment): (typeof existingOpen)[number] | undefined => {
      const semanticKey = `${normalizePath(comment.path)}|${comment.category}`;
      const candidates = existingByPathCategory.get(semanticKey) || [];
      return selectSemanticFindingCandidate({
        comment,
        candidates,
        matchedIds: matchedOldIds
      });
    };

    const reviewComments = filteredComments.inline;
    for (const comment of reviewComments) {
      const hunkHash = hunkHashForComment(diffIndex, comment);
      const contextHash = contextHashForComment(diffIndex, comment);
      const fingerprint = fingerprintForComment(comment);
      const matchKey = matchKeyForComment(comment, hunkHash);
      let existing = existingByKey.get(matchKey);
      if (!existing) {
        const fallbackKey = `${normalizePath(comment.path)}|${hunkHash}|${comment.category}`;
        const candidates = (existingByHunkCategory.get(fallbackKey) || []).filter(
          (candidate) => !matchedOldIds.has(candidate.id)
        );
        if (candidates.length > 0) {
          existing = candidates.sort((a, b) => Math.abs(a.line - comment.line) - Math.abs(b.line - comment.line))[0];
        }
      }
      if (!existing) {
        existing = selectSemanticMatch(comment);
      }
      if (!existing) {
        const semanticTitleKey = semanticFindingKey(comment.path, comment.category, comment.title);
        const candidates = (existingBySemanticTitle.get(semanticTitleKey) || []).filter(
          (candidate) => !matchedOldIds.has(candidate.id)
        );
        if (candidates.length > 0) {
          existing = candidates.sort((a, b) => Math.abs(a.line - comment.line) - Math.abs(b.line - comment.line))[0];
        }
      }

      if (existing) {
        matchedOldIds.add(existing.id);
        stillOpen.push({
          title: comment.title,
          commentId: comment.comment_id,
          path: comment.path,
          category: comment.category
        });
        await prisma.finding.update({
          where: { id: existing.id },
          data: {
            status: "open",
            lastSeenRunId: run.id,
            fingerprint,
            hunkHash,
            contextHash,
            commentId: comment.comment_id,
            commentKey: comment.comment_key,
            path: comment.path,
            line: comment.line,
            side: comment.side,
            severity: comment.severity,
            category: comment.category,
            title: comment.title,
            body: comment.body,
            evidence: comment.evidence,
            suggestedPatch: comment.suggested_patch,
            ruleId: comment.rule_id || null,
            ruleReason: comment.rule_reason || null
          }
        });
        continue;
      }

      newFindings.push({
        title: comment.title,
        commentId: comment.comment_id,
        path: comment.path,
        category: comment.category
      });
      const createdFinding = await prisma.finding.create({
        data: {
          pullRequestId: pullRequest.id,
          reviewRunId: run.id,
          status: "open",
          fingerprint,
          hunkHash,
          contextHash,
          commentId: comment.comment_id,
          commentKey: comment.comment_key,
          path: comment.path,
          line: comment.line,
          side: comment.side,
          severity: comment.severity,
          category: comment.category,
          title: comment.title,
          body: comment.body,
          evidence: comment.evidence,
          suggestedPatch: comment.suggested_patch,
          ruleId: comment.rule_id || null,
          ruleReason: comment.rule_reason || null,
          firstSeenRunId: run.id,
          lastSeenRunId: run.id
        }
      });
      newFindingIds.set(comment.comment_id, createdFinding.id);
    }

    const changedPathSet = new Set(
      changedFiles
        .map((file) => file.path || (file as { filename?: string }).filename || "")
        .filter(Boolean)
        .map((filePath) => normalizePath(filePath))
    );
    const incomingSemanticKeys = new Set(
      reviewComments.map((comment) => semanticFindingKey(comment.path, comment.category, comment.title))
    );
    const fixed = existingOpen.filter((f) => {
      if (matchedOldIds.has(f.id)) return false;
      if (incomingSemanticKeys.has(semanticFindingKey(f.path, f.category, f.title))) return false;
      if (!incrementalReview) return true;
      return changedPathSet.has(normalizePath(f.path));
    });
    const fixedIds = new Set(fixed.map((f) => f.id));
    for (const finding of fixed) {
      const isObsolete = !diffIndex.files.has(normalizePath(finding.path));
      await prisma.finding.update({
        where: { id: finding.id },
        data: { status: isObsolete ? "obsolete" : "fixed", lastSeenRunId: run.id }
      });
    }

    if (fixedIds.size > 0 && client.resolveInlineThread) {
      const fixedReviewComments = await prisma.reviewComment.findMany({
        where: {
          kind: "inline",
          findingId: { in: Array.from(fixedIds) }
        },
        select: {
          providerCommentId: true
        }
      });
      let resolvedThreads = 0;
      let unresolvedThreads = 0;
      let resolveFailures = 0;
      for (const reviewComment of fixedReviewComments) {
        try {
          const resolved = await client.resolveInlineThread(reviewComment.providerCommentId);
          if (resolved) resolvedThreads += 1;
          else unresolvedThreads += 1;
        } catch (err) {
          resolveFailures += 1;
          console.warn("Failed to resolve inline review thread", {
            providerCommentId: reviewComment.providerCommentId,
            error: err
          });
        }
      }
      console.log(
        `[run ${run.id} pr#${prNumber}] inline thread resolution: resolved=${resolvedThreads} unresolved=${unresolvedThreads} failed=${resolveFailures}`
      );
    }

    if (!resolvedConfig.output.summaryOnly && resolvedConfig.commentTypes.allow.includes("inline")) {
      const newCommentIds = new Set(newFindings.map((f) => f.commentId));
      const commentsToPost = reviewComments.filter((c) => newCommentIds.has(c.comment_id));
      let createdInline = 0;
      for (const comment of commentsToPost) {
        const created = await client.createInlineComment({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          body: formatInlineComment(comment)
        });
        const findingId = newFindingIds.get(comment.comment_id);
        createdInline += 1;
        if (findingId) {
          const existingReviewComment = await prisma.reviewComment.findFirst({ where: { findingId } });
          if (existingReviewComment) {
            await prisma.reviewComment.update({
              where: { id: existingReviewComment.id },
              data: {
                providerCommentId: created.id,
                body: created.body,
                url: created.url || null
              }
            });
          } else {
            await prisma.reviewComment.create({
              data: {
                pullRequestId: pullRequest.id,
                findingId,
                kind: "inline",
                providerCommentId: created.id,
                body: created.body,
                url: created.url || null
              }
            });
          }
        }
      }

      const existingComments = await client.listInlineComments();
      const byMarker = new Map<string, ProviderReviewComment>();
      for (const rc of existingComments) {
        const marker = extractCommentId(rc.body || "");
        if (marker) {
          byMarker.set(marker, rc);
        }
      }
      let updatedInline = 0;
      for (const comment of reviewComments) {
        const existing = byMarker.get(comment.comment_id);
        if (!existing) continue;
        const desiredBody = formatInlineComment(comment);
        if ((existing.body || "") !== desiredBody) {
          await client.updateInlineComment(existing.id, desiredBody);
          updatedInline += 1;
        }
      }
      console.log(`[run ${run.id} pr#${prNumber}] inline comments: created=${createdInline} updated=${updatedInline}`);
    }

    const newFindingLinks = newFindings.map((f) => ({
      title: f.title
    }));

    const openFindingLinks = stillOpen.map((f) => ({
      title: f.title
    }));
    if (incrementalReview) {
      const carriedOpenCount = existingOpen.filter(
        (finding) => !matchedOldIds.has(finding.id) && !fixedIds.has(finding.id)
      ).length;
      if (carriedOpenCount > 0) {
        openFindingLinks.push({
          title: `${carriedOpenCount} existing finding${carriedOpenCount === 1 ? "" : "s"} remain open from prior review state.`
        });
      }
    }

    const newSemanticKeys = new Set(newFindings.map((f) => semanticFindingKey(f.path, f.category, f.title)));
    const fixedForStatus = fixed.filter((f) => !newSemanticKeys.has(semanticFindingKey(f.path, f.category, f.title)));
    const overlapSuppressed = fixed.length - fixedForStatus.length;
    const fixedFindingLinks = fixedForStatus.map((f) => ({ title: f.title }));
    const qualityWarnings: string[] = [];
    if (qualityRefinement.diagnostics.deduplicated > 0) {
      qualityWarnings.push(
        `Quality gate deduplicated ${qualityRefinement.diagnostics.deduplicated} overlapping comment(s).`
      );
    }
    if (qualityRefinement.diagnostics.convertedToSummary > 0) {
      qualityWarnings.push(
        `Quality gate converted ${qualityRefinement.diagnostics.convertedToSummary} off-diff comment(s) to summary.`
      );
    }
    if (qualityRefinement.diagnostics.droppedPerFileCap > 0) {
      qualityWarnings.push(
        `Quality gate dropped ${qualityRefinement.diagnostics.droppedPerFileCap} low-priority inline comment(s) due to per-file cap.`
      );
    }
    if (qualityRefinement.diagnostics.downgradedBlocking > 0) {
      qualityWarnings.push(
        `Quality gate downgraded ${qualityRefinement.diagnostics.downgradedBlocking} blocking comment(s) missing a concrete patch.`
      );
    }
    if (coverageDiagnostics.attempted) {
      qualityWarnings.push(
        `Coverage pass scanned ${coverageDiagnostics.targets} uncovered changed file(s) and added ${coverageDiagnostics.added} additional finding(s).`
      );
      if (coverageDiagnostics.droppedDuplicates > 0) {
        qualityWarnings.push(
          `Coverage pass dropped ${coverageDiagnostics.droppedDuplicates} duplicate supplemental finding(s).`
        );
      }
      if (coverageDiagnostics.droppedLowValue > 0) {
        qualityWarnings.push(
          `Coverage pass dropped ${coverageDiagnostics.droppedLowValue} low-value supplemental finding(s).`
        );
      }
    } else if (coveragePlan.stats.uncoveredChanged > 0) {
      qualityWarnings.push(
        `Changed-file coverage before quality gate: ${(coveragePlan.stats.coverageRatio * 100).toFixed(0)}% (${coveragePlan.stats.coveredChanged}/${coveragePlan.stats.totalChanged}).`
      );
    }
    if (fullRepoStaticAudit) {
      qualityWarnings.push("Initial review mode: one-time full-repo static audit with off-diff findings reported as summary comments.");
    }
    if (overlapSuppressed > 0) {
      qualityWarnings.push(
        `Suppressed ${overlapSuppressed} ambiguous finding(s) that appeared in both new and fixed buckets.`
      );
    }
    const statusWarnings = [...warnings, ...qualityWarnings];

    const statusBody = renderStatusComment({
      summary: finalReview.summary,
      newFindings: newFindingLinks,
      openFindings: openFindingLinks,
      fixedFindings: fixedFindingLinks,
      run: {
        id: run.id,
        headSha: refreshed.headSha
      },
      checks: checks.checks,
      warnings: statusWarnings
    });

    if (resolvedConfig.output.destination === "comment" || resolvedConfig.output.destination === "both") {
      const finalStatus = await upsertStatusComment({
        client,
        pullRequestId: pullRequest.id,
        body: statusBody
      });
      console.log(`[run ${run.id} pr#${prNumber}] status comment ${finalStatus.action}: ${finalStatus.url || finalStatus.commentId}`);
    }

    await prisma.reviewRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        configJson: repoConfig,
        draftJson: draft,
        finalJson: finalReview,
        verdictsJson: verdicts,
        checksJson: checks,
        summaryJson: finalReview.summary,
        contextPackJson: contextPack,
        rulesResolvedJson: resolvedConfig,
        rulesUsedJson: finalReview.comments.map((c) => ({ id: c.rule_id, reason: c.rule_reason }))
      }
    });

    if (statusCheckRecord?.id) {
      const conclusion = resolvedConfig.statusChecks.required
        ? hasBlocking
          ? "failure"
          : "success"
        : hasBlocking
          ? "neutral"
          : "success";
      await client.updateStatusCheck(statusCheckRecord.id, {
        name: statusCheckRecord.name,
        status: "completed",
        conclusion,
        summary: "Review completed"
      });
      if (statusCheckRowId) {
        await prisma.statusCheck.update({
          where: { id: statusCheckRowId },
          data: { status: "completed", conclusion }
        });
      }
    }

    await enqueueIndexJob({
      provider,
      installationId: installationId || null,
      repoId: repo.id,
      headSha: refreshed.headSha
    });
    await enqueueAnalyticsJob({ reviewRunId: run.id });
  } catch (err) {
    await prisma.reviewRun.update({
      where: { id: run.id },
      data: { status: "failed", completedAt: new Date() }
    });
    if (statusCheckRecord?.id) {
      await client.updateStatusCheck(statusCheckRecord.id, {
        name: statusCheckRecord.name,
        status: "completed",
        conclusion: "failure",
        summary: "Review failed"
      });
      if (statusCheckRowId) {
        await prisma.statusCheck.update({
          where: { id: statusCheckRowId },
          data: { status: "completed", conclusion: "failure" }
        });
      }
    }
    throw err;
  }
}
