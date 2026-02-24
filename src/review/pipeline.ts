import fs from "fs/promises";
import path from "path";
import { minimatch } from "minimatch";
import { execa } from "execa";
import { prisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { loadRepoConfig, saveRepoConfig } from "./config.js";
import { createRunDirs, writeBundleFiles } from "./bundle.js";
import { buildReviewerPrompt, buildEditorPrompt, buildVerifierPrompt } from "./prompts.js";
import { runCodexStage } from "../runner/codexRunner.js";
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
import { ReviewOutput } from "./schemas.js";
import { getProviderAdapter } from "../providers/registry.js";
import { ProviderPullRequest, ProviderRepo, ProviderStatusCheck, ProviderReviewComment } from "../providers/types.js";
import { enqueueAnalyticsJob, enqueueGraphJob, enqueueIndexJob } from "../queue/enqueue.js";
import { resolveRules } from "./triggers.js";
import { buildContextPack } from "./context.js";
import { getFeedbackPolicy, FeedbackPolicy } from "../services/feedback.js";

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
  const negativeCategories = feedbackPolicy ? new Set(feedbackPolicy.negativeCategories) : null;
  for (const comment of review.comments) {
    if (ignoreGlobs.some((pattern) => minimatch(comment.path, pattern))) continue;
    const evidence = (comment.evidence || "").trim();
    if (evidence.length === 0 || evidence === "\"\"" || evidence === "''") continue;
    if (comment.severity === "blocking" && !comment.suggested_patch) continue;
    const type = comment.comment_type || "inline";
    if (type !== "summary" && !comment.suggested_patch) continue;
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
      summary.push(comment);
      continue;
    }
    if (!summaryOnly) {
      inline.push(comment);
      if (inline.length >= maxInline) break;
    }
  }
  return { inline, summary };
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
  const escapeHtml = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
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

  const fixPrompt = [
    "You are an AI coding assistant.",
    `Fix the issue in ${comment.path}:${comment.line} (${comment.side}).`,
    `Title: ${comment.title}`,
    `Category: ${comment.category}`,
    `Severity: ${comment.severity}`,
    `Details: ${comment.body}`
  ];
  if (suggestedPatch) {
    fixPrompt.push("Suggested change:", suggestedPatch);
  }

  bodyParts.push("<details>", "<summary>Fix with AI</summary>", "");
  bodyParts.push("<pre><code>");
  bodyParts.push(escapeHtml(fixPrompt.join("\n")));
  bodyParts.push("</code></pre>", "</details>");
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
    "",
    "### New",
    renderList(newFindings),
    "",
    "### Still Open",
    renderList(openFindings),
    "",
    "### Fixed Since Last Run",
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
}) {
  const { client, pullRequestId, body } = params;
  const statusComment = await prisma.reviewComment.findFirst({
    where: { pullRequestId, kind: "summary" }
  });

  if (statusComment) {
    try {
      await client.updateSummaryComment(statusComment.providerCommentId, body);
      await prisma.reviewComment.update({
        where: { id: statusComment.id },
        data: { body }
      });
      return;
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
}

function buildFixPrompt(comments: ReviewComment[]): string {
  if (comments.length === 0) {
    return [
      "There are no review findings to fix.",
      "If you made changes, ensure tests and lint still pass."
    ].join("\n");
  }

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
    lines.push(`Evidence: ${comment.evidence}`);
    lines.push(`Details: ${comment.body}`);
    if (comment.suggested_patch) {
      lines.push("Suggested patch:");
      lines.push(normalizeSuggestedPatch(comment.suggested_patch));
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

  const fixPrompt = buildFixPrompt(comments);
  const escapeHtml = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  return [
    start,
    "## Grepiku Summary",
    "",
    "<details>",
    "<summary>Fix with AI</summary>",
    "",
    "<pre><code>",
    escapeHtml(fixPrompt),
    "</code></pre>",
    "</details>",
    "",
    summary.overview,
    "",
    `Risk: ${summary.risk}`,
    summary.confidence !== undefined ? `Confidence: ${(summary.confidence * 100).toFixed(0)}%` : "",
    notableLine,
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
  ].filter((line) => line !== "").join("\n");
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

function generateMermaidDiagram(changedFiles: Array<{ filename?: string; path?: string }>, relatedFiles: string[]): string {
  const nodes = new Set<string>();
  const edges: string[] = [];
  const changed = changedFiles
    .map((file) => file.filename || file.path)
    .filter((value): value is string => Boolean(value));
  for (const file of changed) nodes.add(file);
  for (const rel of relatedFiles) nodes.add(rel);
  for (const file of changed) {
    for (const rel of relatedFiles.slice(0, 5)) {
      if (file !== rel) edges.push(`"${file}" --> "${rel}"`);
    }
  }
  if (nodes.size === 0) return "";
  return ["graph TD", ...edges].join("\n");
}

function enrichSummary(params: {
  summary: ReviewOutput["summary"];
  comments: ReviewComment[];
  changedFiles: Array<{ filename?: string; path?: string }>;
  relatedFiles: string[];
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
    const diagram = generateMermaidDiagram(params.changedFiles, params.relatedFiles);
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

async function buildLocalDiffPatch(params: {
  repoPath: string;
  baseSha: string | null | undefined;
  headSha: string;
}): Promise<string> {
  const { repoPath, baseSha, headSha } = params;
  if (!baseSha) return "";
  const { stdout } = await execa(
    "git",
    ["-C", repoPath, "diff", "--no-color", "--no-ext-diff", `${baseSha}...${headSha}`],
    { maxBuffer: 1024 * 1024 * 200 }
  );
  return stdout;
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

  const run = await prisma.reviewRun.upsert({
    where: {
      pullRequestId_headSha: {
        pullRequestId: pullRequest.id,
        headSha: refreshed.headSha
      }
    },
    update: {
      status: "running",
      startedAt: new Date(),
      trigger
    },
    create: {
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

    const { config: repoConfig, warnings } = await loadRepoConfig(repoPath);
    await saveRepoConfig(repo.id, repoConfig, warnings);
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
    } catch {
      statusCheckRecord = null;
    }
    if (resolvedConfig.output.destination === "comment" || resolvedConfig.output.destination === "both") {
      await upsertStatusComment({
        client,
        pullRequestId: pullRequest.id,
        body: renderReviewingComment()
      });
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

    let diffPatch: string;
    try {
      diffPatch = await client.fetchDiffPatch();
    } catch {
      diffPatch = await buildLocalDiffPatch({
        repoPath,
        baseSha: refreshed.baseSha,
        headSha: refreshed.headSha
      });
    }
    const changedFiles = await client.listChangedFiles();

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
      changedFiles: changedFiles as Array<{ filename?: string; path?: string }>
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

    const feedbackPolicy = await getFeedbackPolicy(repo.id);
    const reviewerPrompt = buildReviewerPrompt(resolvedConfig) + buildFeedbackHint(feedbackPolicy);
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

    const draft = await readAndValidateJson(path.join(outDir, "draft_review.json"), ReviewSchema);

    const editorPrompt = buildEditorPrompt(JSON.stringify(draft, null, 2), diffPatch);
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

    const finalReview = await readAndValidateJson(path.join(outDir, "final_review.json"), ReviewSchema);
    const verdicts = await readAndValidateJson(path.join(outDir, "verdicts.json"), VerdictsSchema);

    finalReview.summary = enrichSummary({
      summary: finalReview.summary,
      comments: finalReview.comments,
      changedFiles: changedFiles as Array<{ filename?: string; path?: string }>,
      relatedFiles: contextPack.relatedFiles
    });

    const diffIndex = buildDiffIndex(diffPatch);
    const verdictMap = new Map(verdicts.verdicts.map((v) => [v.comment_id, v]));
    const commentsAfterVerdict: ReviewComment[] = [];
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

    const filteredComments = filterAndNormalizeComments(
      { ...finalReview, comments: commentsAfterVerdict },
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
    if (resolvedConfig.output.destination === "pr_body" || resolvedConfig.output.destination === "both") {
      if (updatedBody !== originalBody) {
        await client.updatePullRequestBody(updatedBody);
      }
    }

    const checksPrompt = buildVerifierPrompt(refreshed.headSha);
    await runCodexStage({
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
    });
    const checksPath = path.join(outDir, "checks.json");
    let checks: ChecksOutput;
    try {
      checks = await readAndValidateJson(checksPath, ChecksSchema);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      const lastMessagePath = path.join(outDir, "last_message.txt");
      const lastMessage = await fs.readFile(lastMessagePath, "utf8").catch(() => "");
      if (!lastMessage.trim()) throw err;
      checks = parseAndValidateJson(lastMessage, ChecksSchema);
    }

    const existingOpen = await prisma.finding.findMany({
      where: { pullRequestId: pullRequest.id, status: "open" }
    });

    const existingByKey = new Map<string, typeof existingOpen[number]>();
    for (const finding of existingOpen) {
      const key = `${finding.fingerprint}|${finding.path}|${finding.hunkHash}|${finding.title}`;
      existingByKey.set(key, finding);
    }

    const newFindings: Array<{ title: string; url?: string; commentId: string }> = [];
    const stillOpen: Array<{ title: string; url?: string; commentId: string }> = [];
    const matchedOldIds = new Set<number>();

    const reviewComments = filteredComments.inline;
    for (const comment of reviewComments) {
      const hunkHash = hunkHashForComment(diffIndex, comment);
      const contextHash = contextHashForComment(diffIndex, comment);
      const fingerprint = fingerprintForComment(comment);
      const matchKey = matchKeyForComment(comment, hunkHash);
      const existing = existingByKey.get(matchKey);

      if (existing) {
        matchedOldIds.add(existing.id);
        stillOpen.push({ title: comment.title, commentId: comment.comment_id });
        await prisma.finding.update({
          where: { id: existing.id },
          data: {
            status: "open",
            lastSeenRunId: run.id,
            body: comment.body,
            evidence: comment.evidence,
            suggestedPatch: comment.suggested_patch,
            ruleId: comment.rule_id || null,
            ruleReason: comment.rule_reason || null
          }
        });
        continue;
      }

      newFindings.push({ title: comment.title, commentId: comment.comment_id });
      await prisma.finding.create({
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
    }

    const fixed = existingOpen.filter((f) => !matchedOldIds.has(f.id));
    for (const finding of fixed) {
      const isObsolete = !diffIndex.files.has(normalizePath(finding.path));
      await prisma.finding.update({
        where: { id: finding.id },
        data: { status: isObsolete ? "obsolete" : "fixed", lastSeenRunId: run.id }
      });
    }

    if (!resolvedConfig.output.summaryOnly && resolvedConfig.commentTypes.allow.includes("inline")) {
      const newCommentIds = new Set(newFindings.map((f) => f.commentId));
      const commentsToPost = reviewComments.filter((c) => newCommentIds.has(c.comment_id));
      for (const comment of commentsToPost) {
        const created = await client.createInlineComment({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          body: formatInlineComment(comment)
        });
        await prisma.reviewComment.create({
          data: {
            pullRequestId: pullRequest.id,
            findingId: (await prisma.finding.findFirst({ where: { pullRequestId: pullRequest.id, commentId: comment.comment_id } }))?.id || undefined,
            kind: "inline",
            providerCommentId: created.id,
            body: created.body,
            url: created.url || null
          }
        });
      }

      const existingComments = await client.listInlineComments();
      const byMarker = new Map<string, ProviderReviewComment>();
      for (const rc of existingComments) {
        const marker = extractCommentId(rc.body || "");
        if (marker) {
          byMarker.set(marker, rc);
        }
      }
      for (const comment of reviewComments) {
        const existing = byMarker.get(comment.comment_id);
        if (!existing) continue;
        const desiredBody = formatInlineComment(comment);
        if ((existing.body || "") !== desiredBody) {
          await client.updateInlineComment(existing.id, desiredBody);
        }
      }
    }

    const updatedOpen = await prisma.finding.findMany({
      where: {
        pullRequestId: pullRequest.id,
        status: "open"
      }
    });

    const newFindingLinks = newFindings.map((f) => ({
      title: f.title
    }));

    const openFindingLinks = stillOpen.map((f) => ({
      title: f.title
    }));

    const fixedFindingLinks = fixed.map((f) => ({ title: f.title }));

    const statusBody = renderStatusComment({
      summary: finalReview.summary,
      newFindings: newFindingLinks,
      openFindings: openFindingLinks,
      fixedFindings: fixedFindingLinks,
      checks: checks.checks,
      warnings
    });

    if (resolvedConfig.output.destination === "comment" || resolvedConfig.output.destination === "both") {
      await upsertStatusComment({
        client,
        pullRequestId: pullRequest.id,
        body: statusBody
      });
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
    await enqueueGraphJob({ repoId: repo.id });
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
