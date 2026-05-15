import {
  EditorDecisionOutput,
  ReviewComment,
  ReviewCommentSchema,
  ReviewOutput,
  ReviewSummary,
  VerdictsOutput
} from "./schemas.js";

export type CompactEditorInput = {
  summary: ReviewSummary;
  comments: Array<{
    comment_id: string;
    path: string;
    line: number;
    side: ReviewComment["side"];
    severity: ReviewComment["severity"];
    category: ReviewComment["category"];
    title: string;
    body: string;
    evidence: string;
    has_suggested_patch: boolean;
    confidence?: ReviewComment["confidence"];
  }>;
  omitted_comment_ids: string[];
};

const SEVERITY_SCORE: Record<ReviewComment["severity"], number> = {
  blocking: 0,
  important: 1,
  nit: 2
};

const CATEGORY_SCORE: Record<ReviewComment["category"], number> = {
  security: 0,
  bug: 1,
  performance: 2,
  testing: 3,
  maintainability: 4,
  style: 5
};

const CONFIDENCE_SCORE: Record<NonNullable<ReviewComment["confidence"]>, number> = {
  high: 0,
  medium: 1,
  low: 2
};

const HIGH_IMPACT_PATTERN =
  /\b(race|concurrent|concurrency|transaction|unique|constraint|lock|lost update|data loss|authorization|auth|permission|secret|token|credential|injection|xss|cross-user|scope)\b/i;

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n[truncated]`;
}

function highImpactScore(comment: ReviewComment): number {
  const text = `${comment.path}\n${comment.title}\n${comment.body}\n${comment.evidence}`;
  return HIGH_IMPACT_PATTERN.test(text) ? 0 : 1;
}

function sortCommentsForEditor(comments: ReviewComment[]): ReviewComment[] {
  return [...comments].sort((a, b) => {
    const severityDelta = SEVERITY_SCORE[a.severity] - SEVERITY_SCORE[b.severity];
    if (severityDelta !== 0) return severityDelta;
    const impactDelta = highImpactScore(a) - highImpactScore(b);
    if (impactDelta !== 0) return impactDelta;
    const categoryDelta = CATEGORY_SCORE[a.category] - CATEGORY_SCORE[b.category];
    if (categoryDelta !== 0) return categoryDelta;
    const confidenceDelta =
      CONFIDENCE_SCORE[a.confidence || "medium"] - CONFIDENCE_SCORE[b.confidence || "medium"];
    if (confidenceDelta !== 0) return confidenceDelta;
    return `${a.path}:${a.line}:${a.title}`.localeCompare(`${b.path}:${b.line}:${b.title}`);
  });
}

function uniqueStrings(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

export function buildCompactEditorInput(params: {
  draft: ReviewOutput;
  maxComments: number;
  maxTextChars?: number;
}): CompactEditorInput {
  const maxComments = Math.max(1, Math.floor(params.maxComments));
  const maxTextChars = Math.max(200, Math.floor(params.maxTextChars ?? 700));
  const selected = sortCommentsForEditor(params.draft.comments).slice(0, maxComments);
  const selectedIds = new Set(selected.map((comment) => comment.comment_id));
  return {
    summary: {
      ...params.draft.summary,
      overview: truncateText(params.draft.summary.overview, 1800),
      key_concerns: uniqueStrings(params.draft.summary.key_concerns, 12),
      what_to_test: uniqueStrings(params.draft.summary.what_to_test, 16),
      file_breakdown: (params.draft.summary.file_breakdown || [])
        .slice(0, 80)
        .map((item) => ({
          ...item,
          summary: truncateText(item.summary, 240)
        }))
    },
    comments: selected.map((comment) => ({
      comment_id: comment.comment_id,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      severity: comment.severity,
      category: comment.category,
      title: truncateText(comment.title, 180),
      body: truncateText(comment.body, maxTextChars),
      evidence: truncateText(comment.evidence, maxTextChars),
      has_suggested_patch: Boolean(comment.suggested_patch?.trim()),
      confidence: comment.confidence
    })),
    omitted_comment_ids: params.draft.comments
      .map((comment) => comment.comment_id)
      .filter((commentId) => !selectedIds.has(commentId))
  };
}

export function buildDeterministicEditorDecisionOutput(
  editorInput: CompactEditorInput
): EditorDecisionOutput {
  return {
    summary: editorInput.summary,
    verdicts: {
      verdicts: editorInput.comments.map((comment) => ({
        comment_id: comment.comment_id,
        decision: "keep" as const,
        confidence: comment.confidence || "medium",
        reason: "Selected by compact editor ranking."
      }))
    }
  };
}

export function applyEditorDecisionOutput(params: {
  draft: ReviewOutput;
  editorInput: CompactEditorInput;
  decisionOutput: EditorDecisionOutput;
}): { finalReview: ReviewOutput; verdicts: VerdictsOutput } {
  const candidates = new Map(
    params.draft.comments
      .filter((comment) =>
        params.editorInput.comments.some((candidate) => candidate.comment_id === comment.comment_id)
      )
      .map((comment) => [comment.comment_id, comment])
  );
  const verdictMap = new Map(
    params.decisionOutput.verdicts.verdicts.map((verdict) => [verdict.comment_id, verdict])
  );
  const finalComments: ReviewComment[] = [];
  for (const candidate of params.editorInput.comments) {
    const original = candidates.get(candidate.comment_id);
    if (!original) continue;
    const verdict = verdictMap.get(candidate.comment_id);
    if (verdict?.decision === "drop") continue;
    if (verdict?.decision === "revise" && verdict.revised_comment) {
      const revised = ReviewCommentSchema.safeParse(verdict.revised_comment);
      if (revised.success) {
        finalComments.push(revised.data);
        continue;
      }
    }
    finalComments.push(original);
  }

  const explicitVerdicts = params.decisionOutput.verdicts.verdicts;
  const decided = new Set(explicitVerdicts.map((verdict) => verdict.comment_id));
  const omittedVerdicts = params.editorInput.omitted_comment_ids.map((commentId) => ({
    comment_id: commentId,
    decision: "drop" as const,
    confidence: "medium" as const,
    reason: "Omitted from compact editor candidate set."
  }));
  const defaultKeepVerdicts = params.editorInput.comments
    .filter((comment) => !decided.has(comment.comment_id))
    .map((comment) => ({
      comment_id: comment.comment_id,
      decision: "keep" as const,
      confidence: "medium" as const,
      reason: "Kept by default because editor returned no explicit verdict."
    }));

  return {
    finalReview: {
      summary: params.decisionOutput.summary,
      comments: finalComments
    },
    verdicts: {
      verdicts: [...explicitVerdicts, ...defaultKeepVerdicts, ...omittedVerdicts]
    }
  };
}
