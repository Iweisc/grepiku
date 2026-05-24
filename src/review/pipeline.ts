import fs from "fs/promises";
import path from "path";
import { minimatch } from "minimatch";
import { ZodSchema } from "zod";
import { prisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { loadRepoConfigAtGitRef, saveRepoConfig, type RepoConfig } from "./config.js";
import { createRunDirs, writeBundleFiles } from "./bundle.js";
import {
  buildReviewerPrompt,
  buildDirectReviewerPrompt,
  buildAgenticReviewerPrompt,
  buildEditorPrompt,
  buildVerifierPrompt,
  buildCoverageReviewerPrompt,
  type ReviewPromptOptions
} from "./prompts.js";
import { CodexStage, runCodexStage } from "../runner/codexRunner.js";
import { runDirectModelStage } from "../runner/directModelRunner.js";
import { readAndValidateJsonWithFallback } from "./json.js";
import {
  ReviewSchema,
  VerdictsSchema,
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
import {
  semanticFindingKey,
  selectFixedFindingCandidates,
  selectPreferredExactKeyFinding
} from "./findingLifecycle.js";
import { generateMermaidDiagram } from "./diagram.js";
import { ReviewOutput, VerdictsOutput } from "./schemas.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderAdapter, ProviderPullRequest, ProviderRepo, ProviderStatusCheck, ProviderReviewComment } from "../providers/types.js";
import { buildReviewJobId } from "../queue/jobId.js";
import { resolveRules } from "./triggers.js";
import { buildContextPack, type ContextPack } from "./context.js";
import { getFeedbackPolicy, FeedbackPolicy } from "../services/feedback.js";
import { getRepoWeights } from "../services/weights.js";
import { refineReviewComments, sanitizeCommentIdentifier } from "./quality.js";
import {
  buildLocalChangedFiles,
  buildLocalDiffPatch,
  resolveDiffPatchAfterLocalCompareFailure
} from "./localCompare.js";
import { renderPrMarkdown } from "./prMarkdown.js";
import { sanitizeModelVisibleReviewData } from "./sensitiveReviewData.js";
import { loadAcceptedRepoMemoryRules, mergeRulesWithRepoMemory } from "../services/repoMemory.js";
import { buildIncrementalReviewContext } from "./incrementalContext.js";
import { buildVerifierSkippedChecks, readVerifierChecks } from "./checks.js";
import {
  buildCoveragePlan,
  mergeSupplementalComments,
  mergeSupplementalSummary
} from "./coverage.js";
import { sanitizeGitHubMarkdownText } from "./githubMarkdown.js";
import { normalizeSuggestedPatchText, stripEdgeBlankLines } from "./text.js";
import { shouldRunVerifierForPullRequest, shouldSkipReviewForSelfAuthoredPullRequest } from "../providers/pullRequestGuards.js";
import { selectTrustedPullRequestIndexSha } from "../providers/bootstrapIndex.js";
import { resolveGithubBotLogin } from "../providers/github/adapter.js";
import { mergeStoredPullRequestState } from "./pullRequestState.js";
import {
  buildReviewDiffChunkPlan,
  mergeChunkReviewDrafts,
  type ReviewChunkDraft,
  type ReviewDiffChunk,
  type ReviewDiffChunkPlan
} from "./diffChunks.js";
import {
  buildContextPackForChunk,
  chunkHasHighImpactHotspot
} from "./chunkContext.js";
import {
  applyEditorDecisionOutput,
  buildCompactEditorInput,
  buildDeterministicEditorDecisionOutput
} from "./editorDecision.js";

const env = loadEnv();
const CHUNKED_REVIEW_MIN_CHANGED_LINES = 16_000;
const CHUNKED_REVIEW_TARGET_CHANGED_LINES = 6_000;
const CHUNKED_REVIEW_MAX_CHANGED_LINES = 7_000;
const CHUNKED_REVIEW_HIGH_TARGET_CHANGED_LINES = 3_000;

function shouldRecoverRunningDuplicateRun(params: {
  duplicateRunStatus: string;
  currentJobId?: string | null;
  expectedJobId?: string | null;
}): boolean {
  return (
    params.duplicateRunStatus === "running" &&
    Boolean(params.currentJobId) &&
    Boolean(params.expectedJobId) &&
    params.currentJobId === params.expectedJobId
  );
}

function shouldSkipDuplicateReviewRun(params: {
  duplicateRunStatus: string;
  currentJobId?: string | null;
  expectedJobId?: string | null;
}): boolean {
  if (params.duplicateRunStatus === "completed") {
    return true;
  }
  if (params.duplicateRunStatus === "running") {
    return !shouldRecoverRunningDuplicateRun(params);
  }
  return false;
}

async function failInterruptedDuplicateRun(params: {
  runId: number;
  client: { updateStatusCheck: (checkId: string, check: ProviderStatusCheck) => Promise<ProviderStatusCheck> };
}): Promise<void> {
  const completedAt = new Date();
  const staleChecks = await prisma.statusCheck.findMany({
    where: { reviewRunId: params.runId, status: "in_progress" }
  });

  for (const statusCheck of staleChecks) {
    if (statusCheck.providerCheckId) {
      try {
        await params.client.updateStatusCheck(statusCheck.providerCheckId, {
          name: statusCheck.name,
          status: "completed",
          conclusion: "failure",
          summary: "Review interrupted",
          text: "A previous review worker stopped before finishing this run. Grepiku is retrying the review.",
          detailsUrl: statusCheck.detailsUrl || undefined
        });
      } catch (error) {
        console.warn(
          `[run ${params.runId}] failed to close interrupted check ${statusCheck.providerCheckId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    await prisma.statusCheck.update({
      where: { id: statusCheck.id },
      data: { status: "completed", conclusion: "failure" }
    });
  }

  await prisma.reviewRun.update({
    where: { id: params.runId },
    data: { status: "failed", completedAt }
  });
}

const CHUNKED_REVIEW_HIGH_MAX_CHANGED_LINES = 3_800;
const CHUNKED_REVIEW_MAX_FILES = 240;

type LargePrReviewMode = "direct" | "agentic";

function largePrReviewMode(): LargePrReviewMode {
  return env.largePrReviewMode;
}

function shouldUseAgenticChunkReviewer(params: {
  mode?: LargePrReviewMode;
  sandboxExecutionMode?: "local" | "kubernetes";
  chunkCount: number;
  totalChangedLines: number;
}): boolean {
  return (
    (params.mode ?? largePrReviewMode()) === "agentic" &&
    (params.sandboxExecutionMode ?? env.sandboxExecutionMode) !== "kubernetes" &&
    params.chunkCount > 1 &&
    params.totalChangedLines >= CHUNKED_REVIEW_MIN_CHANGED_LINES
  );
}

function reviewHasInspectedEvidence(review: ReviewOutput, filesInspected: string[]): boolean {
  if (review.comments.length === 0) return true;
  const inspected = new Set(filesInspected.map((item) => normalizePath(item)));
  return review.comments.every((comment) => {
    const evidence = (comment.evidence || "").trim();
    if (!evidence) return false;
    return inspected.size === 0 || inspected.has(normalizePath(comment.path));
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function writeAgenticReviewerDiagnostics(params: {
  chunkId: string;
  reviewMode: string;
  chunkOutDir: string;
  review?: ReviewOutput | null;
  error?: unknown;
}): Promise<void> {
  const latestMetricsPath = path.join(params.chunkOutDir, "stage_metrics_latest_reviewer.json");
  const stageMetrics = await fs
    .readFile(latestMetricsPath, "utf8")
    .then((raw) =>
      JSON.parse(raw) as {
        usage?: unknown;
        durationMs?: unknown;
        agentic?: {
          shellCommands?: string[];
          grCommands?: string[];
          filesInspected?: string[];
          retrievalCalls?: number;
          graphCalls?: number;
          fallbackDiagnostics?: string[];
        };
      }
    )
    .catch(() => null);
  const agentic = stageMetrics?.agentic || null;
  const filesInspected = agentic?.filesInspected || [];
  const grCommands = agentic?.grCommands || [];
  const retrievalCalls = agentic?.retrievalCalls || 0;
  const changedContextCalls = grCommands.filter((command) => /\bgr\s+changed-context\b/.test(command)).length;
  const contextFallbackDiagnostics = [...(agentic?.fallbackDiagnostics || [])];
  if (!params.error && (params.review?.comments.length || 0) > 0 && retrievalCalls === 0 && changedContextCalls === 0) {
    contextFallbackDiagnostics.push(
      "completed agentic review produced findings without gr retrieve or gr changed-context usage"
    );
  }
  await fs.writeFile(
    path.join(params.chunkOutDir, "agentic_reviewer_diagnostics.json"),
    JSON.stringify(
      {
        chunkId: params.chunkId,
        mode: params.reviewMode,
        status: params.error ? "failed" : "completed",
        elapsedMs: stageMetrics?.durationMs ?? null,
        tokenUsage: stageMetrics?.usage ?? null,
        shellCommands: agentic?.shellCommands || [],
        grCommands,
        filesInspected,
        retrievalCalls,
        changedContextCalls,
        graphCalls: agentic?.graphCalls || 0,
        contextFallbackDiagnostics,
        findingsCiteInspectedEvidence: params.review
          ? reviewHasInspectedEvidence(params.review, filesInspected)
          : null,
        error: params.error ? errorMessage(params.error) : null
      },
      null,
      2
    ),
    "utf8"
  );
}

const CHUNKED_REVIEW_MAX_PARALLEL = 48;
const CHUNKED_EDITOR_MAX_CANDIDATE_COMMENTS = 48;

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

type ReviewQueuePublisher = (data: any) => Promise<void>;

export type ReviewJobOptions = {
  jobId?: string | null;
  adapter?: ProviderAdapter;
  resolveBotLogin?: () => Promise<string>;
  enqueueIndexJob?: ReviewQueuePublisher;
  enqueueAnalyticsJob?: ReviewQueuePublisher;
};

async function defaultEnqueueIndexJob(data: any): Promise<void> {
  const { enqueueIndexJob } = await import("../queue/enqueue.js");
  await enqueueIndexJob(data);
}

async function defaultEnqueueAnalyticsJob(data: any): Promise<void> {
  const { enqueueAnalyticsJob } = await import("../queue/enqueue.js");
  await enqueueAnalyticsJob(data);
}

 

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

function hasBlockingVisibleFindings(params: {
  inline: Array<Pick<ReviewComment, "severity">>;
  summary: Array<Pick<ReviewComment, "severity">>;
}): boolean {
  return [...params.inline, ...params.summary].some(
    (comment) => comment.severity === "blocking"
  );
}

function hasFailingVerifierChecks(checks: ChecksOutput["checks"]): boolean {
  return [checks.lint, checks.build, checks.test].some((result) =>
    ["fail", "timeout", "error"].includes(result.status)
  );
}

function resolveStatusCheckConclusion(params: {
  required: boolean;
  inline: Array<Pick<ReviewComment, "severity">>;
  summary: Array<Pick<ReviewComment, "severity">>;
  checks: ChecksOutput["checks"];
}): "success" | "failure" | "neutral" {
  const hasBlocking = hasBlockingVisibleFindings({
    inline: params.inline,
    summary: params.summary
  });
  const hasVerifierFailure = hasFailingVerifierChecks(params.checks);
  if (!hasBlocking && !hasVerifierFailure) {
    return "success";
  }
  return params.required ? "failure" : "neutral";
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
  const markerId = sanitizeCommentIdentifier(
    comment.comment_id,
    `${normalizePath(comment.path)}|${comment.side}|${comment.line}|${comment.title}`,
    64
  );
  const marker = `<!-- grepiku:${markerId} -->`;
  const maxBacktickRun = (value: string) => {
    const matches = value.match(/`+/g);
    return matches?.reduce((max, match) => Math.max(max, match.length), 0) || 0;
  };
  const buildFencedBlock = (value: string, infoString: string) => {
    const fence = "`".repeat(Math.max(3, maxBacktickRun(value) + 1));
    return `${fence}${infoString}\n${value}\n${fence}`;
  };
  const normalizeSuggestedPatch = (patch: string) => {
    let normalized = normalizeSuggestedPatchText(patch);
    normalized = normalized
      .replace(/^```(?:suggestion|diff)?\n?/i, "")
      .replace(/```$/, "");
    normalized = stripEdgeBlankLines(normalized);
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
    `**${comment.severity.toUpperCase()}** ${sanitizeGitHubMarkdownText(comment.title)}`,
    `Category: ${sanitizeGitHubMarkdownText(comment.category)}`,
    comment.rule_id ? `Rule: ${sanitizeGitHubMarkdownText(comment.rule_id)}` : null,
    sanitizeGitHubMarkdownText(comment.body)
  ].filter((line) => line !== null);

  const suggestedPatch = comment.suggested_patch
    ? normalizeSuggestedPatch(comment.suggested_patch)
    : null;

  if (suggestedPatch) {
    bodyParts.push("Suggested change:", buildFencedBlock(suggestedPatch, "suggestion"));
  }

  return bodyParts.join("\n\n");
}

function extractCommentId(body: string): string | null {
  const match = body.match(/<!--\s*grepiku:([^\s]+)\s*-->/);
  return match ? match[1] : null;
}

function normalizeBotAwareLogin(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\[bot\]$/i, "");
}

function buildExistingInlineCommentLookup(
  comments: ProviderReviewComment[],
  botLogin: string
): Map<string, ProviderReviewComment> {
  const byMarker = new Map<string, ProviderReviewComment>();
  const normalizedBotLogin = normalizeBotAwareLogin(botLogin);
  if (!normalizedBotLogin) {
    return byMarker;
  }

  for (const comment of comments) {
    if (normalizeBotAwareLogin(comment.authorLogin) !== normalizedBotLogin) {
      continue;
    }
    const marker = extractCommentId(comment.body || "");
    if (marker) {
      byMarker.set(marker, comment);
    }
  }

  return byMarker;
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
    return items
      .map((item) => {
        const safeTitle = sanitizeGitHubMarkdownText(item.title);
        return item.url ? `- [View finding](${item.url}) ${safeTitle}` : `- ${safeTitle}`;
      })
      .join("\n");
  };

  const renderFixed = () => {
    if (fixedFindings.length === 0) return "- (none)";
    return fixedFindings.map((item) => `- ${sanitizeGitHubMarkdownText(item.title)}`).join("\n");
  };

  const renderCheck = (name: string, result: { status: string; summary: string; top_errors: string[] }) => {
    const errors = result.top_errors.length
      ? result.top_errors.map((e) => `  - ${sanitizeGitHubMarkdownText(e)}`).join("\n")
      : "  - (none)";
    return `**${name}**: ${result.status} - ${sanitizeGitHubMarkdownText(result.summary)}\n${errors}`;
  };

  const lines = [
    "## AI Review Status",
    "",
    `- **Overview:** ${sanitizeGitHubMarkdownText(summary.overview)}`,
    `- **Risk:** ${sanitizeGitHubMarkdownText(summary.risk)}`,
    summary.confidence !== undefined ? `- **Confidence:** ${(summary.confidence * 100).toFixed(0)}%` : "",
    params.run ? `- **Run:** #${params.run.id} (\`${params.run.headSha.slice(0, 12)}\`)` : "",
    ""
  ].filter(Boolean);

  lines.push("### New Findings", renderList(newFindings), "");

  if (openFindings.length > 0) {
    lines.push("### Open Findings", renderList(openFindings), "");
  }

  if (fixedFindings.length > 0) {
    lines.push("### Fixed Findings", renderFixed(), "");
  }

  if (warnings && warnings.length > 0) {
    lines.push("### Config Warnings", warnings.map((w) => `- ${sanitizeGitHubMarkdownText(w)}`).join("\n"), "");
  }

  lines.push(
    "<details>",
    "<summary>Checks</summary>",
    "",
    renderCheck("lint", checks.lint),
    "",
    renderCheck("build", checks.build),
    "",
    renderCheck("test", checks.test),
    "</details>"
  );

  return lines.join("\n");
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
    let normalized = normalizeSuggestedPatchText(patch);
    normalized = normalized
      .replace(/^```(?:suggestion|diff)?\n?/i, "")
      .replace(/```$/, "");
    normalized = stripEdgeBlankLines(normalized);
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
  const buildFencedBlock = (value: string, infoString: string) => {
    const matches = value.match(/`+/g);
    const maxBacktickRun =
      matches?.reduce((max, match) => Math.max(max, match.length), 0) || 0;
    const fence = "`".repeat(Math.max(3, maxBacktickRun + 1));
    return [`${fence}${infoString}`, value, fence];
  };
  const start = "<!-- grepiku-summary:start -->";
  const end = "<!-- grepiku-summary:end -->";
  const severityOrder = { blocking: 0, important: 1, nit: 2 } as const;
  const allFindings = [...comments, ...summaryComments].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );
  const notable = allFindings[0];
  const topFindings =
    allFindings.length > 0
      ? allFindings
          .slice(0, 5)
          .map(
            (item) =>
              `- [${sanitizeGitHubMarkdownText(item.severity)}] ${sanitizeGitHubMarkdownText(item.title)}`
          )
          .join("\n")
      : "- (none)";
  const keyConcerns =
    summary.key_concerns.length > 0
      ? summary.key_concerns
          .slice(0, 6)
          .map((c) => `- ${sanitizeGitHubMarkdownText(c)}`)
          .join("\n")
      : "- (none)";
  const whatToTest =
    summary.what_to_test.length > 0
      ? summary.what_to_test
          .slice(0, 6)
          .map((c) => `- ${sanitizeGitHubMarkdownText(c)}`)
          .join("\n")
      : "- (none)";

  const notableLine = notable
    ? sanitizeGitHubMarkdownText(`${notable.title} (${notable.severity})`)
    : "(none)";

  const fileBreakdownEntries = summary.file_breakdown || [];
  const shownFileBreakdown = fileBreakdownEntries
    .slice(0, 12)
    .map(
      (file) =>
        `- ${sanitizeGitHubMarkdownText(file.path)}: ${sanitizeGitHubMarkdownText(file.summary)}${
          file.risk ? ` (risk: ${sanitizeGitHubMarkdownText(file.risk)})` : ""
        }`
    );
  const omittedFileBreakdown = Math.max(0, fileBreakdownEntries.length - shownFileBreakdown.length);
  const fileBreakdown =
    shownFileBreakdown.length > 0
      ? [
          ...shownFileBreakdown,
          ...(omittedFileBreakdown > 0 ? [`- [${omittedFileBreakdown} additional file summary item(s) hidden]`] : [])
        ].join("\n")
      : "- (none)";

  const summaryFindings =
    summaryComments.length > 0
      ? summaryComments
          .slice(0, 8)
          .map((c) => `- ${sanitizeGitHubMarkdownText(c.title)}: ${sanitizeGitHubMarkdownText(c.body)}`)
          .join("\n")
      : "- (none)";

  const patternBlock =
    patternMatches.length > 0
      ? patternMatches
          .slice(0, 10)
          .map((match) => `- ${sanitizeGitHubMarkdownText(match)}`)
          .join("\n")
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

  const detailBlock = [
    "<details>",
    "<summary>Review details</summary>",
    "",
    "Key concerns:",
    keyConcerns,
    "",
    "File breakdown:",
    fileBreakdown,
    "",
    "Summary findings:",
    summaryFindings,
    "",
    "Pattern matches:",
    patternBlock,
    ...(summary.diagram_mermaid ? ["", "Diagram:", ...buildFencedBlock(summary.diagram_mermaid, "mermaid")] : []),
    "</details>"
  ].join("\n");

  return [
    start,
    "## Grepiku Summary",
    "",
    `- **Overview:** ${sanitizeGitHubMarkdownText(summary.overview)}`,
    `- **Risk:** ${sanitizeGitHubMarkdownText(summary.risk)}`,
    summary.confidence !== undefined ? `- **Confidence:** ${(summary.confidence * 100).toFixed(0)}%` : null,
    `- **Notable issue:** ${notableLine}`,
    "",
    "### Top Findings",
    topFindings,
    "",
    "### What to Test",
    whatToTest,
    "",
    fixBlock,
    "",
    detailBlock,
    end
  ]
    .filter((line) => line !== null)
    .join("\n");
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
  const diagram = generateMermaidDiagram({
    changedFiles: params.changedFiles,
    relatedFiles: params.relatedFiles,
    graphLinks: params.graphLinks
  });
  if (diagram) summary.diagram_mermaid = diagram;
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

async function readJsonWithFallback<T>(
  filePath: string,
  schema: ZodSchema<T>,
  stage: CodexStage
): Promise<T> {
  const fallbackPath = path.join(path.dirname(filePath), `last_message_${stage}.txt`);
  return readAndValidateJsonWithFallback(filePath, fallbackPath, schema);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function serializableChunkPlan(plan: ReviewDiffChunkPlan): unknown {
  return {
    stats: plan.stats,
    chunks: plan.chunks.map((chunk) => ({
      id: chunk.id,
      ordinal: chunk.ordinal,
      paths: chunk.paths,
      changedLines: chunk.changedLines,
      additions: chunk.additions,
      deletions: chunk.deletions,
      risk: chunk.risk,
      diffBytes: Buffer.byteLength(chunk.diffPatch, "utf8")
    }))
  };
}

function reasoningEffortForChunk(
  chunk: ReviewDiffChunk,
  contextPack: ContextPack
): "low" | "medium" | "high" | "xhigh" {
  if (env.codexModelReasoningEffort !== "high") {
    return env.codexModelReasoningEffort;
  }
  if (chunkHasHighImpactHotspot(contextPack, chunk)) return "high";
  return "low";
}

async function runReviewerChunk(params: {
  chunk: ReviewDiffChunk;
  chunkCount: number;
  totalChangedLines: number;
  repoPath: string;
  bundleDir: string;
  outDir: string;
  codexHomeDir: string;
  prMarkdown: string;
  repoConfig: RepoConfig;
  resolvedConfig: RepoConfig;
  contextPack: ContextPack;
  previousReviewContext: unknown;
  warnings: string[];
  promptOptions: ReviewPromptOptions;
  feedbackPolicy: FeedbackPolicy;
  prTitle?: string | null;
  prBody?: string | null;
  baseSha?: string | null;
  headSha: string;
  repoId: number;
  runId: number;
  prNumber: number;
}): Promise<ReviewChunkDraft> {
  const chunkBundleDir = path.join(params.bundleDir, "review_chunks", params.chunk.id);
  const chunkOutDir = path.join(params.outDir, "review_chunks", params.chunk.id);
  const chunkCodexHomeDir = path.join(params.codexHomeDir, "review_chunks", params.chunk.id);
  await fs.mkdir(chunkBundleDir, { recursive: true });
  await fs.mkdir(chunkOutDir, { recursive: true });
  await fs.mkdir(chunkCodexHomeDir, { recursive: true });
  const chunkContextPack = await buildContextPackForChunk({
    repoId: params.repoId,
    repoPath: params.repoPath,
    headSha: params.headSha,
    chunk: params.chunk,
    config: params.resolvedConfig,
    prTitle: params.prTitle,
    prBody: params.prBody,
    fallbackContextPack: params.contextPack
  });

  await writeBundleFiles({
    bundleDir: chunkBundleDir,
    prMarkdown: params.prMarkdown,
    diffPatch: params.chunk.diffPatch,
    changedFiles: params.chunk.changedFiles,
    repoConfig: params.repoConfig,
    resolvedConfig: params.resolvedConfig,
    contextPack: chunkContextPack,
    previousReviewContext: params.previousReviewContext,
    warnings: params.warnings
  });

  const chunkPromptPaths = {
    repoPath: params.repoPath,
    bundleDir: chunkBundleDir,
    outDir: chunkOutDir
  };
  const chunkPromptOptions = {
    ...params.promptOptions,
    fullRepoStaticAudit: false,
    chunkReview: {
      chunkId: params.chunk.id,
      ordinal: params.chunk.ordinal,
      totalChunks: params.chunkCount,
      changedLines: params.chunk.changedLines,
      totalChangedLines: params.totalChangedLines,
      paths: params.chunk.paths
    }
  } satisfies ReviewPromptOptions;
  const reasoningEffort = reasoningEffortForChunk(params.chunk, chunkContextPack);
  const reviewMode = largePrReviewMode();

  console.log(
    `[run ${params.runId} pr#${params.prNumber}] reviewer ${params.chunk.id} starting ` +
      `files=${params.chunk.paths.length} changedLines=${params.chunk.changedLines} risk=${params.chunk.risk}`
  );
  if (reviewMode === "agentic") {
    const reviewerPrompt =
      buildAgenticReviewerPrompt({
        paths: chunkPromptPaths,
        baseSha: params.baseSha,
        headSha: params.headSha,
        prNumber: params.prNumber,
        chunkReview: chunkPromptOptions.chunkReview,
        config: params.resolvedConfig
      }) + buildFeedbackHint(params.feedbackPolicy);
    try {
      await runCodexStage({
        stage: "reviewer",
        repoPath: params.repoPath,
        bundleDir: chunkBundleDir,
        outDir: chunkOutDir,
        codexHomeDir: chunkCodexHomeDir,
        prompt: reviewerPrompt,
        headSha: params.headSha,
        repoId: params.repoId,
        reviewRunId: params.runId,
        prNumber: params.prNumber,
        reasoningEffort,
        reviewerMode: "agentic"
      });
    } catch (err) {
      await writeAgenticReviewerDiagnostics({
        chunkId: params.chunk.id,
        reviewMode,
        chunkOutDir,
        error: err
      }).catch(() => undefined);
      throw err;
    }
  } else {
    try {
      await runDirectModelStage({
        stage: "reviewer",
        outDir: chunkOutDir,
        prompt:
          buildDirectReviewerPrompt({
            config: params.resolvedConfig,
            prMarkdown: params.prMarkdown,
            diffPatch: params.chunk.diffPatch,
            changedFiles: params.chunk.changedFiles,
            contextPack: chunkContextPack,
            warnings: params.warnings,
            options: chunkPromptOptions
          }) + buildFeedbackHint(params.feedbackPolicy),
        reviewRunId: params.runId,
        prNumber: params.prNumber,
        reasoningEffort,
        outputFileName: "draft_review.json"
      });
    } catch (err) {
      console.warn(
        `[run ${params.runId} pr#${params.prNumber}] direct reviewer ${params.chunk.id} failed; falling back to codex: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      const reviewerPrompt =
        buildReviewerPrompt(params.resolvedConfig, chunkPromptPaths, chunkPromptOptions) +
        buildFeedbackHint(params.feedbackPolicy);
      await runCodexStage({
        stage: "reviewer",
        repoPath: params.repoPath,
        bundleDir: chunkBundleDir,
        outDir: chunkOutDir,
        codexHomeDir: chunkCodexHomeDir,
        prompt: reviewerPrompt,
        headSha: params.headSha,
        repoId: params.repoId,
        reviewRunId: params.runId,
        prNumber: params.prNumber,
        reasoningEffort
      });
    }
  }

  const review = await readJsonWithFallback(
    path.join(chunkOutDir, "draft_review.json"),
    ReviewSchema,
    "reviewer"
  );
  if (reviewMode === "agentic") {
    await writeAgenticReviewerDiagnostics({
      chunkId: params.chunk.id,
      reviewMode,
      chunkOutDir,
      review
    });
  }
  return { chunk: params.chunk, review };
}

async function runChunkedReviewer(params: {
  plan: ReviewDiffChunkPlan;
  repoPath: string;
  bundleDir: string;
  outDir: string;
  codexHomeDir: string;
  prMarkdown: string;
  repoConfig: RepoConfig;
  resolvedConfig: RepoConfig;
  contextPack: ContextPack;
  previousReviewContext: unknown;
  warnings: string[];
  promptOptions: ReviewPromptOptions;
  feedbackPolicy: FeedbackPolicy;
  prTitle?: string | null;
  prBody?: string | null;
  baseSha?: string | null;
  headSha: string;
  repoId: number;
  runId: number;
  prNumber: number;
}): Promise<ReviewOutput> {
  const drafts = await mapWithConcurrency(
    params.plan.chunks,
    CHUNKED_REVIEW_MAX_PARALLEL,
    (chunk) =>
      runReviewerChunk({
        chunk,
        chunkCount: params.plan.chunks.length,
        totalChangedLines: params.plan.stats.totalChangedLines,
        repoPath: params.repoPath,
        bundleDir: params.bundleDir,
        outDir: params.outDir,
        codexHomeDir: params.codexHomeDir,
        prMarkdown: params.prMarkdown,
        repoConfig: params.repoConfig,
        resolvedConfig: params.resolvedConfig,
        contextPack: params.contextPack,
        previousReviewContext: params.previousReviewContext,
        warnings: params.warnings,
        promptOptions: params.promptOptions,
        feedbackPolicy: params.feedbackPolicy,
        prTitle: params.prTitle,
        prBody: params.prBody,
        baseSha: params.baseSha,
        headSha: params.headSha,
        repoId: params.repoId,
        runId: params.runId,
        prNumber: params.prNumber
      })
  );
  return mergeChunkReviewDrafts({
    drafts,
    maxKeyConcerns: params.resolvedConfig.limits.max_key_concerns
  });
}

export async function processReviewJob(
  data: ReviewJobData,
  options: ReviewJobOptions = {}
) {
  const { provider, installationId, repoId, pullRequestId, prNumber, headSha, trigger, rulesOverride } = data;
  const repo = await prisma.repo.findFirst({ where: { id: repoId } });
  const pullRequestRecord = await prisma.pullRequest.findFirst({ where: { id: pullRequestId } });
  if (!repo || !pullRequestRecord) return;

  const installation = installationId
    ? await prisma.installation.findFirst({ where: { externalId: installationId } })
    : null;

  const adapter = options.adapter ?? getProviderAdapter(provider);
  const resolveBotLogin = options.resolveBotLogin ?? resolveGithubBotLogin;
  const enqueueIndex = options.enqueueIndexJob ?? defaultEnqueueIndexJob;
  const enqueueAnalytics = options.enqueueAnalyticsJob ?? defaultEnqueueAnalyticsJob;
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
  if (refreshed.state === "closed") {
    console.log(`[pr#${prNumber}] PR is closed; skipping review`);
    return;
  }
  const skipSelfReviewBotLogin = provider === "github" ? await resolveBotLogin().catch(() => "") : "";
  if (
    provider === "github" &&
    shouldSkipReviewForSelfAuthoredPullRequest({
      pullRequest: refreshed,
      botLogin: skipSelfReviewBotLogin
    })
  ) {
    console.log(
      `[pr#${prNumber}] skipping review for self-authored bot PR (author=${refreshed.author?.login || "unknown"}, head=${refreshed.headRef || "unknown"})`
    );
    return;
  }
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

  const refreshedPullRequestState = mergeStoredPullRequestState(
    {
      title: pullRequestRecord.title,
      body: pullRequestRecord.body,
      url: pullRequestRecord.url,
      state: pullRequestRecord.state,
      baseRef: pullRequestRecord.baseRef,
      headRef: pullRequestRecord.headRef,
      baseSha: pullRequestRecord.baseSha,
      headSha: pullRequestRecord.headSha,
      draft: pullRequestRecord.draft
    },
    refreshed
  );

  const pullRequest = await prisma.pullRequest.update({
    where: { id: pullRequestRecord.id },
    data: {
      title: refreshedPullRequestState.title,
      body: refreshedPullRequestState.body,
      url: refreshedPullRequestState.url,
      state: refreshedPullRequestState.state,
      baseRef: refreshedPullRequestState.baseRef,
      headRef: refreshedPullRequestState.headRef,
      baseSha: refreshedPullRequestState.baseSha,
      headSha: refreshedPullRequestState.headSha,
      draft: refreshedPullRequestState.draft,
      authorId: authorUser?.id || pullRequestRecord.authorId
    }
  });

  if (!data.force) {
    const duplicateRun = await prisma.reviewRun.findFirst({
      where: {
        pullRequestId: pullRequest.id,
        headSha: refreshed.headSha,
        status: { in: ["running", "completed"] }
      },
      orderBy: { createdAt: "desc" }
    });
    if (duplicateRun) {
      const expectedJobId = buildReviewJobId(data);
      const recoverRunningDuplicate = shouldRecoverRunningDuplicateRun({
        duplicateRunStatus: duplicateRun.status,
        currentJobId: options.jobId,
        expectedJobId
      });
      if (recoverRunningDuplicate) {
        console.warn(
          `[pr#${prNumber}] recovering interrupted run #${duplicateRun.id} for retried job ${options.jobId}`
        );
        await failInterruptedDuplicateRun({ runId: duplicateRun.id, client });
      } else if (
        shouldSkipDuplicateReviewRun({
          duplicateRunStatus: duplicateRun.status,
          currentJobId: options.jobId,
          expectedJobId
        })
      ) {
        console.log(
          `[pr#${prNumber}] duplicate review request skipped: existing run #${duplicateRun.id} (${duplicateRun.status}) for ${refreshed.headSha.slice(0, 12)}`
        );
        return;
      }
    }
  }

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

    const { config: trustedRepoConfig, warnings } = await loadRepoConfigAtGitRef(
      repoPath,
      refreshed.baseSha || pullRequestRecord.baseSha || null
    );
    await saveRepoConfig(repo.id, trustedRepoConfig, warnings);
    const memoryRules = await loadAcceptedRepoMemoryRules(repo.id);
    const repoConfig =
      memoryRules.length > 0
        ? { ...trustedRepoConfig, rules: mergeRulesWithRepoMemory(trustedRepoConfig.rules, memoryRules) }
        : trustedRepoConfig;
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
      await enqueueIndex({
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
      diffPatch = await resolveDiffPatchAfterLocalCompareFailure({
        fetchProviderDiff: () => client.fetchDiffPatch(),
        buildLocalDiff: () =>
          buildLocalDiffPatch({
            repoPath,
            baseSha: refreshed.baseSha,
            headSha: refreshed.headSha
          })
      });
      changedFiles = await client.listChangedFiles();
    }

    const modelVisibleReviewData = sanitizeModelVisibleReviewData({
      diffPatch,
      changedFiles
    });
    diffPatch = modelVisibleReviewData.diffPatch;
    changedFiles = modelVisibleReviewData.changedFiles;
    if (modelVisibleReviewData.sensitivePaths.length > 0) {
      console.log(
        `[run ${run.id} pr#${prNumber}] withheld ${modelVisibleReviewData.sensitivePaths.length} sensitive changed path(s) from model-visible review context`
      );
    }
    if (modelVisibleReviewData.bulkNoisePaths.length > 0) {
      console.log(
        `[run ${run.id} pr#${prNumber}] omitted ${modelVisibleReviewData.bulkNoisePaths.length} bulk/noise changed path(s) from model-visible review context`
      );
    }

    const prMarkdown = renderPrMarkdown({
      title: refreshedPullRequestState.title || "Untitled",
      number: prNumber,
      author: refreshed.author?.login || "unknown",
      body: refreshedPullRequestState.body,
      baseRef: refreshedPullRequestState.baseRef,
      headRef: refreshedPullRequestState.headRef,
      headSha: refreshedPullRequestState.headSha,
      url: refreshedPullRequestState.url,
      sensitivePathsWithheld: modelVisibleReviewData.sensitivePaths
    });

    const contextPack = await buildContextPack({
      repoId: repo.id,
      diffPatch,
      repoPath,
      headSha: refreshedPullRequestState.headSha,
      changedFiles: changedFiles as Array<{
        filename?: string;
        path?: string;
        status?: string;
        additions?: number;
        deletions?: number;
      }>,
      prTitle: refreshedPullRequestState.title,
      prBody: refreshedPullRequestState.body,
      retrieval: resolvedConfig.retrieval,
      graph: resolvedConfig.graph
    });

    const incrementalReviewContext =
      incrementalReview && previousRun
        ? buildIncrementalReviewContext({
            previousRun: {
              id: previousRun.id,
              headSha: previousRun.headSha,
              trigger: previousRun.trigger,
              completedAt: previousRun.completedAt,
              finalJson: previousRun.finalJson,
              summaryJson: previousRun.summaryJson
            },
            openFindings: await prisma.finding.findMany({
              where: { pullRequestId: pullRequest.id, status: "open" },
              select: {
                path: true,
                line: true,
                severity: true,
                category: true,
                title: true,
                body: true,
                ruleId: true,
                ruleReason: true
              }
            })
          })
        : null;

    const { bundleDir, outDir, codexHomeDir } = await createRunDirs(env.projectRoot, run.id);
    await writeBundleFiles({
      bundleDir,
      prMarkdown,
      diffPatch,
      changedFiles,
      repoConfig,
      resolvedConfig,
      contextPack,
      previousReviewContext: incrementalReviewContext,
      warnings
    });

    const promptPaths = {
      repoPath,
      bundleDir,
      outDir
    };
    let verifierPromise!: Promise<{ ok: true } | { ok: false; error: unknown }>;

    const [feedbackPolicy, repoWeights] = await Promise.all([
      getFeedbackPolicy(repo.id),
      getRepoWeights(repo.id)
    ]);
    const promptOptions = {
      fullRepoStaticAudit,
      ...(incrementalReview && incrementalFrom && incrementalReviewContext
        ? {
            incrementalReview: {
              fromHeadSha: incrementalFrom,
              toHeadSha: refreshed.headSha
            }
          }
        : {})
    };
    const chunkPlan = buildReviewDiffChunkPlan({
      diffPatch,
      changedFiles: changedFiles as Array<{
        filename?: string;
        path?: string;
        status?: string;
        additions?: number;
        deletions?: number;
      }>,
      changedFileStats: contextPack.changedFileStats,
      targetChangedLines: CHUNKED_REVIEW_TARGET_CHANGED_LINES,
      maxChangedLines: CHUNKED_REVIEW_MAX_CHANGED_LINES,
      highRiskTargetChangedLines: CHUNKED_REVIEW_HIGH_TARGET_CHANGED_LINES,
      highRiskMaxChangedLines: CHUNKED_REVIEW_HIGH_MAX_CHANGED_LINES,
      maxFiles: CHUNKED_REVIEW_MAX_FILES
    });
    await fs.writeFile(
      path.join(outDir, "review_chunk_plan.json"),
      JSON.stringify(serializableChunkPlan(chunkPlan), null, 2),
      "utf8"
    );
    const shouldUseChunkedReviewer =
      chunkPlan.chunks.length > 1 &&
      chunkPlan.stats.totalChangedLines >= CHUNKED_REVIEW_MIN_CHANGED_LINES;
    let draft: ReviewOutput;
    if (shouldUseChunkedReviewer) {
      console.log(
        `[run ${run.id} pr#${prNumber}] using chunked reviewer mode=${largePrReviewMode()} ` +
          `chunks=${chunkPlan.chunks.length} changedLines=${chunkPlan.stats.totalChangedLines}`
      );
      draft = await runChunkedReviewer({
        plan: chunkPlan,
        repoPath,
        bundleDir,
        outDir,
        codexHomeDir,
        prMarkdown,
        repoConfig,
        resolvedConfig,
        contextPack,
        previousReviewContext: incrementalReviewContext,
        warnings,
        promptOptions,
        feedbackPolicy,
        prTitle: refreshedPullRequestState.title,
        prBody: refreshedPullRequestState.body,
        baseSha: refreshed.baseSha,
        headSha: refreshed.headSha,
        repoId: repo.id,
        runId: run.id,
        prNumber
      });
      await fs.writeFile(
        path.join(outDir, "draft_review.json"),
        JSON.stringify(draft, null, 2),
        "utf8"
      );
    } else {
      const reviewerPrompt =
        buildReviewerPrompt(resolvedConfig, promptPaths, promptOptions) +
        buildFeedbackHint(feedbackPolicy);
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

      draft = await readJsonWithFallback(
        path.join(outDir, "draft_review.json"),
        ReviewSchema,
        "reviewer"
      );
    }

    let finalReview: ReviewOutput;
    let verdicts: VerdictsOutput;
    if (shouldUseChunkedReviewer) {
      const editorInput = buildCompactEditorInput({
        draft,
        maxComments: Math.max(
          resolvedConfig.limits.max_inline_comments,
          Math.min(CHUNKED_EDITOR_MAX_CANDIDATE_COMMENTS, resolvedConfig.limits.max_inline_comments * 2)
        )
      });
      await fs.writeFile(path.join(outDir, "editor_input.json"), JSON.stringify(editorInput, null, 2), "utf8");
      const decisionOutput = buildDeterministicEditorDecisionOutput(editorInput);
      await fs.writeFile(
        path.join(outDir, "editor_decision.json"),
        JSON.stringify(decisionOutput, null, 2),
        "utf8"
      );
      const applied = applyEditorDecisionOutput({ draft, editorInput, decisionOutput });
      finalReview = applied.finalReview;
      verdicts = applied.verdicts;
      await fs.writeFile(path.join(outDir, "final_review.json"), JSON.stringify(finalReview, null, 2), "utf8");
      await fs.writeFile(path.join(outDir, "verdicts.json"), JSON.stringify(verdicts, null, 2), "utf8");
    } else {
      const editorPrompt = buildEditorPrompt(JSON.stringify(draft, null, 2), promptPaths, promptOptions);
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

      finalReview = await readJsonWithFallback(
        path.join(outDir, "final_review.json"),
        ReviewSchema,
        "editor"
      );
      verdicts = await readJsonWithFallback(
        path.join(outDir, "verdicts.json"),
        VerdictsSchema,
        "editor"
      );
    }

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
      !shouldUseChunkedReviewer &&
      env.sandboxExecutionMode !== "kubernetes" &&
      coveragePlan.targets.length > 0 &&
      !resolvedConfig.output.summaryOnly &&
      resolvedConfig.commentTypes.allow.includes("inline");

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
      feedbackPolicy,
      repoWeights
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
    const hasBlocking = hasBlockingVisibleFindings(filteredComments);

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

    const verifierEligible = shouldRunVerifierForPullRequest({
      repoFullName: repo.fullName,
      pullRequest: refreshed
    });
    if (verifierEligible && !shouldUseChunkedReviewer) {
      const checksPrompt = buildVerifierPrompt(refreshed.headSha, promptPaths);
      verifierPromise = runCodexStage({
        stage: "verifier",
        repoPath,
        bundleDir,
        outDir,
        codexHomeDir,
        prompt: checksPrompt,
        headSha: refreshed.headSha,
        repoId: repo.id,
        reviewRunId: run.id,
        prNumber
      })
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => ({ ok: false as const, error }));
    } else {
      const skippedChecks = buildVerifierSkippedChecks({
        headSha: refreshed.headSha,
        summary: shouldUseChunkedReviewer
          ? "skipped for chunked large review"
          : "skipped for untrusted fork pull request"
      });
      await fs.writeFile(
        path.join(outDir, "checks.json"),
        JSON.stringify(skippedChecks, null, 2),
        "utf8"
      );
      console.warn(
        shouldUseChunkedReviewer
          ? `[run ${run.id} pr#${prNumber}] skipping verifier tools for chunked large review`
          : `[run ${run.id} pr#${prNumber}] skipping verifier tools for head repo ${refreshed.headRepoFullName || "unknown"}`
      );
      verifierPromise = Promise.resolve({ ok: true as const });
    }

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
      resolvedConfig.output.syncSummaryWithStatus ||
      resolvedConfig.output.destination === "pr_body" ||
      resolvedConfig.output.destination === "both" ||
      originalBody.trim().length === 0;
    const allowBodyUpdate =
      resolvedConfig.output.allowIncrementalPrBodyUpdates || !incrementalReview;
    if (shouldUpdateBody && allowBodyUpdate && updatedBody !== originalBody) {
      try {
        await client.updatePullRequestBody(updatedBody);
      } catch (err) {
        console.warn("Failed to update PR body summary block", err);
      }
    }

    const verifierResult = await verifierPromise;
    const checks: ChecksOutput = await readVerifierChecks({
      outDir,
      headSha: refreshed.headSha,
      stageError: verifierResult.ok ? undefined : verifierResult.error,
      logPrefix: `[run ${run.id} pr#${prNumber}]`
    });

    const existingOpenOrFixed = await prisma.finding.findMany({
      where: { pullRequestId: pullRequest.id, status: { in: ["open", "fixed"] } }
    });
    const seenRunIds = Array.from(
      new Set(
        existingOpenOrFixed
          .map((finding) => finding.lastSeenRunId || finding.reviewRunId)
          .filter((id): id is number => typeof id === "number")
      )
    );
    const seenRuns = seenRunIds.length
      ? await prisma.reviewRun.findMany({
          where: { id: { in: seenRunIds } },
          select: { id: true, headSha: true }
        })
      : [];
    const headShaByRunId = new Map<number, string>(seenRuns.map((seenRun) => [seenRun.id, seenRun.headSha]));
    const existingOpen = existingOpenOrFixed.filter((finding) => finding.status === "open");
    const sameHeadFixed = existingOpenOrFixed.filter((finding) => {
      if (finding.status !== "fixed") return false;
      const seenRunId = finding.lastSeenRunId || finding.reviewRunId;
      const seenHeadSha = headShaByRunId.get(seenRunId);
      return Boolean(seenHeadSha) && seenHeadSha === refreshed.headSha;
    });
    const existingCandidates = [...existingOpen, ...sameHeadFixed];

    const existingByKey = new Map<string, typeof existingCandidates[number]>();
    const existingByHunkCategory = new Map<string, Array<typeof existingCandidates[number]>>();
    const existingByPathCategory = new Map<string, Array<typeof existingCandidates[number]>>();
    const existingBySemanticTitle = new Map<string, Array<typeof existingCandidates[number]>>();
    for (const finding of existingCandidates) {
      const key = `${finding.fingerprint}|${finding.path}|${finding.hunkHash}|${finding.title}`;
      const current = existingByKey.get(key);
      existingByKey.set(key, selectPreferredExactKeyFinding(current, finding));
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

    const selectSemanticMatch = (comment: ReviewComment): (typeof existingCandidates)[number] | undefined => {
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
    const fixed = selectFixedFindingCandidates({
      existingOpen,
      matchedOldIds,
      incomingSemanticKeys,
      incrementalReview,
      changedPathSet,
      currentHeadSha: refreshed.headSha,
      headShaByRunId
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

      let updatedInline = 0;
      const inlineSyncBotLogin =
        provider === "github" ? await resolveBotLogin().catch(() => "") : "";
      if (!inlineSyncBotLogin) {
        console.warn(
          `[run ${run.id} pr#${prNumber}] inline comment sync skipped: bot identity unavailable`
        );
      } else {
        const existingComments = await client.listInlineComments({
          bodyIncludes: "<!-- grepiku:",
          authorLogin: inlineSyncBotLogin
        });
        const byMarker = buildExistingInlineCommentLookup(
          existingComments,
          inlineSyncBotLogin
        );
        for (const comment of reviewComments) {
          const markerId = sanitizeCommentIdentifier(
            comment.comment_id,
            `${normalizePath(comment.path)}|${comment.side}|${comment.line}|${comment.title}`,
            64
          );
          const existing = byMarker.get(markerId);
          if (!existing) continue;
          const desiredBody = formatInlineComment(comment);
          if ((existing.body || "") !== desiredBody) {
            await client.updateInlineComment(existing.id, desiredBody);
            updatedInline += 1;
          }
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
      const carriedOpenFindings = existingOpen
        .filter((finding) => !matchedOldIds.has(finding.id) && !fixedIds.has(finding.id))
        .sort((a, b) => {
          const pathCmp = a.path.localeCompare(b.path);
          if (pathCmp !== 0) return pathCmp;
          if (a.line !== b.line) return a.line - b.line;
          return a.title.localeCompare(b.title);
        });
      for (const finding of carriedOpenFindings) {
        openFindingLinks.push({
          title: finding.title
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
      const conclusion = resolveStatusCheckConclusion({
        required: resolvedConfig.statusChecks.required,
        inline: filteredComments.inline,
        summary: filteredComments.summary,
        checks: checks.checks
      });
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

    const trustedRepoIndexSha = selectTrustedPullRequestIndexSha({
      baseSha: refreshed.baseSha || pullRequest.baseSha || null,
      headSha: refreshed.headSha
    });
    if (trustedRepoIndexSha) {
      await enqueueIndex({
        provider,
        installationId: installationId || null,
        repoId: repo.id,
        headSha: trustedRepoIndexSha
      });
    }
    await enqueueAnalytics({ reviewRunId: run.id });
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

export const __pipelineInternals = {
  buildExistingInlineCommentLookup,
  buildSummaryBlock,
  failInterruptedDuplicateRun,
  formatInlineComment,
  hasFailingVerifierChecks,
  hasBlockingVisibleFindings,
  renderStatusComment,
  resolveStatusCheckConclusion,
  largePrReviewMode,
  shouldUseAgenticChunkReviewer,
  reviewHasInspectedEvidence,
  writeAgenticReviewerDiagnostics,
  shouldRecoverRunningDuplicateRun,
  shouldSkipDuplicateReviewRun,
  upsertSummaryBlock
};
