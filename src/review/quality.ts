import crypto from "crypto";
import type { FeedbackPolicy } from "../services/feedback.js";
import { isLineInDiff, normalizePath, type DiffIndex } from "./diff.js";
import type { ReviewComment } from "./schemas.js";

export type QualityDiagnostics = {
  droppedEmpty: number;
  deduplicated: number;
  convertedToSummary: number;
  downgradedBlocking: number;
  droppedPerFileCap: number;
};

type RankedComment = {
  comment: ReviewComment;
  score: number;
};

const PLACEHOLDER_VALUES = new Set(["", "\"\"", "''", "n/a", "none", "(none)"]);

const severityWeight: Record<ReviewComment["severity"], number> = {
  blocking: 100,
  important: 65,
  nit: 25
};

const confidenceWeight: Record<NonNullable<ReviewComment["confidence"]>, number> = {
  high: 1,
  medium: 0.7,
  low: 0.35
};

const categoryWeight: Record<ReviewComment["category"], number> = {
  security: 25,
  bug: 20,
  performance: 15,
  testing: 12,
  maintainability: 8,
  style: 2
};

function sha1(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+\n/g, "\n").trim();
}

function normalizeSingleLine(value: string): string {
  return normalizeWhitespace(value).replace(/\s+/g, " ");
}

function isMeaningful(value: string): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  return !PLACEHOLDER_VALUES.has(normalized);
}

function commentTypeFor(comment: ReviewComment): "inline" | "summary" {
  return comment.comment_type === "summary" ? "summary" : "inline";
}

function normalizedTitleKey(value: string): string {
  return normalizeSingleLine(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeSuggestedPatch(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeComment(input: ReviewComment): ReviewComment {
  const normalized: ReviewComment = {
    ...input,
    path: normalizePath(input.path),
    title: normalizeSingleLine(input.title),
    body: normalizeWhitespace(input.body),
    evidence: normalizeWhitespace(input.evidence),
    suggested_patch: normalizeSuggestedPatch(input.suggested_patch),
    comment_type: commentTypeFor(input),
    comment_id: normalizeSingleLine(input.comment_id),
    comment_key: normalizeSingleLine(input.comment_key)
  };
  if (!normalized.comment_id) {
    normalized.comment_id = sha1(
      `${normalized.path}|${normalized.side}|${normalized.line}|${normalized.title}`
    ).slice(0, 12);
  }
  if (!normalized.comment_key) {
    normalized.comment_key = sha1(
      `${normalized.path}|${normalized.line}|${normalized.category}|${normalized.title}`
    ).slice(0, 16);
  }
  return normalized;
}

function priorityScore(
  comment: ReviewComment,
  params: {
    diffIndex: DiffIndex;
    changedPathSet: Set<string>;
    feedbackPolicy?: FeedbackPolicy;
  }
): number {
  const confidence = comment.confidence ? confidenceWeight[comment.confidence] : 0.7;
  const inChangedPath = params.changedPathSet.has(normalizePath(comment.path));
  const inDiff = isLineInDiff(params.diffIndex, comment);
  const feedbackPenalty =
    params.feedbackPolicy && params.feedbackPolicy.negativeCategories.includes(comment.category)
      ? 18
      : 0;
  const feedbackBoost =
    params.feedbackPolicy && params.feedbackPolicy.positiveCategories.includes(comment.category)
      ? 8
      : 0;
  const suggestionBoost = comment.suggested_patch ? 6 : 0;
  const evidenceBoost = Math.min(6, Math.floor(comment.evidence.length / 80));
  const placementBoost = inDiff ? 6 : 0;
  const changedPathBoost = inChangedPath ? 4 : 0;
  return (
    severityWeight[comment.severity] * confidence +
    categoryWeight[comment.category] +
    suggestionBoost +
    evidenceBoost +
    placementBoost +
    changedPathBoost +
    feedbackBoost -
    feedbackPenalty
  );
}

function dedupeAndKeepStrongest(items: RankedComment[]): { kept: RankedComment[]; dropped: number } {
  const byKey = new Map<string, RankedComment>();
  let dropped = 0;
  for (const item of items) {
    const c = item.comment;
    const key = [
      normalizePath(c.path),
      c.side,
      c.line,
      c.category,
      normalizedTitleKey(c.title),
      commentTypeFor(c)
    ].join("|");
    const existing = byKey.get(key);
    if (!existing || item.score > existing.score) {
      if (existing) dropped += 1;
      byKey.set(key, item);
      continue;
    }
    dropped += 1;
  }
  return { kept: Array.from(byKey.values()), dropped };
}

function enforceUniqueIds(comments: ReviewComment[]): ReviewComment[] {
  const idCount = new Map<string, number>();
  const keyCount = new Map<string, number>();
  return comments.map((comment) => {
    const idSeen = idCount.get(comment.comment_id) || 0;
    const keySeen = keyCount.get(comment.comment_key) || 0;
    idCount.set(comment.comment_id, idSeen + 1);
    keyCount.set(comment.comment_key, keySeen + 1);
    if (idSeen === 0 && keySeen === 0) return comment;
    return {
      ...comment,
      comment_id: `${comment.comment_id}-${idSeen + 1}`,
      comment_key: `${comment.comment_key}-${keySeen + 1}`
    };
  });
}

export function refineReviewComments(params: {
  comments: ReviewComment[];
  diffIndex: DiffIndex;
  changedFiles: Array<{ filename?: string; path?: string }>;
  maxInlineComments: number;
  summaryOnly?: boolean;
  allowedTypes?: Array<"inline" | "summary">;
  feedbackPolicy?: FeedbackPolicy;
}): {
  comments: ReviewComment[];
  diagnostics: QualityDiagnostics;
} {
  const diagnostics: QualityDiagnostics = {
    droppedEmpty: 0,
    deduplicated: 0,
    convertedToSummary: 0,
    downgradedBlocking: 0,
    droppedPerFileCap: 0
  };

  const changedPathSet = new Set(
    params.changedFiles
      .map((file) => normalizePath(file.filename || file.path || ""))
      .filter(Boolean)
  );

  const ranked: RankedComment[] = [];
  const summaryOnly = Boolean(params.summaryOnly);
  const allowedInline = params.allowedTypes
    ? params.allowedTypes.includes("inline")
    : true;
  const forceSummary = summaryOnly || !allowedInline;
  for (const rawComment of params.comments) {
    const comment = normalizeComment(rawComment);
    if (!isMeaningful(comment.title) || !isMeaningful(comment.body) || !isMeaningful(comment.evidence)) {
      diagnostics.droppedEmpty += 1;
      continue;
    }
    if (comment.category === "style" && comment.severity !== "nit") {
      comment.severity = "nit";
    }
    if (comment.severity === "blocking" && !comment.suggested_patch) {
      comment.severity = "important";
      diagnostics.downgradedBlocking += 1;
    }
    if (forceSummary && commentTypeFor(comment) !== "summary") {
      comment.comment_type = "summary";
      diagnostics.convertedToSummary += 1;
    }
    if (commentTypeFor(comment) !== "summary" && !isLineInDiff(params.diffIndex, comment)) {
      comment.comment_type = "summary";
      diagnostics.convertedToSummary += 1;
    }
    ranked.push({
      comment,
      score: priorityScore(comment, {
        diffIndex: params.diffIndex,
        changedPathSet,
        feedbackPolicy: params.feedbackPolicy
      })
    });
  }

  const deduped = dedupeAndKeepStrongest(ranked);
  diagnostics.deduplicated = deduped.dropped;

  const maxPerFile = Math.max(2, Math.min(6, Math.ceil(params.maxInlineComments / 3)));
  const keptInlineByPath = new Map<string, number>();
  const afterPerFileCap: RankedComment[] = [];

  const rankedByPriority = deduped.kept.sort((a, b) => b.score - a.score);
  for (const item of rankedByPriority) {
    const type = commentTypeFor(item.comment);
    if (type === "summary" || forceSummary) {
      afterPerFileCap.push(item);
      continue;
    }
    const pathKey = normalizePath(item.comment.path);
    const count = keptInlineByPath.get(pathKey) || 0;
    if (count >= maxPerFile) {
      diagnostics.droppedPerFileCap += 1;
      continue;
    }
    keptInlineByPath.set(pathKey, count + 1);
    afterPerFileCap.push(item);
  }

  const sorted = afterPerFileCap
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.comment.path !== b.comment.path) return a.comment.path.localeCompare(b.comment.path);
      return a.comment.line - b.comment.line;
    })
    .map((item) => item.comment);

  return {
    comments: enforceUniqueIds(sorted),
    diagnostics
  };
}
