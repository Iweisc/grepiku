import { minimatch } from "minimatch";
import { z } from "zod";
import { normalizePath } from "../review/diff.js";
import type { ReviewComment, ReviewOutput } from "../review/schemas.js";

export const EvalFindingLabelSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).optional(),
  severity: z.enum(["blocking", "important", "nit"]).optional(),
  category: z
    .enum(["bug", "security", "performance", "maintainability", "testing", "style"])
    .optional(),
  titleRegex: z.string().min(1).optional(),
  bodyRegex: z.string().min(1).optional(),
  evidenceRegex: z.string().min(1).optional(),
  textRegex: z.string().min(1).optional()
});

export const ReviewEvalCaseSchema = z.object({
  id: z.string().min(1),
  reviewPath: z.string().min(1).optional(),
  expectedFindings: z.array(EvalFindingLabelSchema).default([]),
  falsePositiveFindings: z.array(EvalFindingLabelSchema).default([])
});

export const ReviewEvalFileSchema = z.object({
  cases: z.array(ReviewEvalCaseSchema).min(1),
  thresholds: z
    .object({
      minRecall: z.number().min(0).max(1).optional(),
      minJudgedPrecision: z.number().min(0).max(1).optional()
    })
    .optional()
});

export type EvalFindingLabel = z.infer<typeof EvalFindingLabelSchema>;
export type ReviewEvalCase = z.infer<typeof ReviewEvalCaseSchema>;
export type ReviewEvalFile = z.infer<typeof ReviewEvalFileSchema>;

export type FindingLabelResult = {
  label: EvalFindingLabel;
  matched: boolean;
  matchedCommentIds: string[];
};

export type ReviewEvalCaseResult = {
  id: string;
  expectedCount: number;
  expectedMatched: number;
  expectedMissed: string[];
  falsePositiveCount: number;
  falsePositiveMatched: number;
  falsePositiveHits: string[];
  recall: number | null;
  judgedPrecision: number | null;
  expected: FindingLabelResult[];
  falsePositives: FindingLabelResult[];
};

export type ReviewEvalSummary = {
  caseCount: number;
  expectedCount: number;
  expectedMatched: number;
  falsePositiveCount: number;
  falsePositiveMatched: number;
  recall: number | null;
  judgedPrecision: number | null;
  thresholdStatus: {
    pass: boolean;
    failures: string[];
  };
  cases: ReviewEvalCaseResult[];
};

function compileRegex(value: string | undefined): RegExp | null {
  return value ? new RegExp(value, "i") : null;
}

function isGlobPath(value: string): boolean {
  return /[*?[\]{}()!+@]/.test(value);
}

function pathMatches(labelPath: string | undefined, commentPath: string): boolean {
  if (!labelPath) return true;
  const normalizedLabel = normalizePath(labelPath);
  const normalizedComment = normalizePath(commentPath);
  if (isGlobPath(normalizedLabel)) {
    return minimatch(normalizedComment, normalizedLabel, { dot: true });
  }
  return normalizedLabel === normalizedComment;
}

function commentText(comment: ReviewComment): string {
  return [comment.title, comment.body, comment.evidence].filter(Boolean).join("\n");
}

export function commentMatchesLabel(comment: ReviewComment, label: EvalFindingLabel): boolean {
  if (!pathMatches(label.path, comment.path)) return false;
  if (label.severity && comment.severity !== label.severity) return false;
  if (label.category && comment.category !== label.category) return false;

  const titleRegex = compileRegex(label.titleRegex);
  const bodyRegex = compileRegex(label.bodyRegex);
  const evidenceRegex = compileRegex(label.evidenceRegex);
  const textRegex = compileRegex(label.textRegex);

  if (titleRegex && !titleRegex.test(comment.title)) return false;
  if (bodyRegex && !bodyRegex.test(comment.body)) return false;
  if (evidenceRegex && !evidenceRegex.test(comment.evidence)) return false;
  if (textRegex && !textRegex.test(commentText(comment))) return false;
  return true;
}

function evaluateLabels(
  comments: ReviewComment[],
  labels: EvalFindingLabel[]
): FindingLabelResult[] {
  return labels.map((label) => {
    const matchedCommentIds = comments
      .filter((comment) => commentMatchesLabel(comment, label))
      .map((comment) => comment.comment_id);
    return {
      label,
      matched: matchedCommentIds.length > 0,
      matchedCommentIds
    };
  });
}

export function evaluateReviewCase(params: {
  case: ReviewEvalCase;
  review: ReviewOutput;
}): ReviewEvalCaseResult {
  const expected = evaluateLabels(params.review.comments, params.case.expectedFindings);
  const falsePositives = evaluateLabels(params.review.comments, params.case.falsePositiveFindings);
  const expectedMatched = expected.filter((item) => item.matched).length;
  const falsePositiveMatched = falsePositives.filter((item) => item.matched).length;
  const recall =
    expected.length > 0 ? expectedMatched / expected.length : null;
  const judgedPrecision =
    expectedMatched + falsePositiveMatched > 0
      ? expectedMatched / (expectedMatched + falsePositiveMatched)
      : null;

  return {
    id: params.case.id,
    expectedCount: expected.length,
    expectedMatched,
    expectedMissed: expected.filter((item) => !item.matched).map((item) => item.label.id),
    falsePositiveCount: falsePositives.length,
    falsePositiveMatched,
    falsePositiveHits: falsePositives
      .filter((item) => item.matched)
      .map((item) => item.label.id),
    recall,
    judgedPrecision,
    expected,
    falsePositives
  };
}

export function summarizeReviewEval(params: {
  cases: ReviewEvalCaseResult[];
  minRecall?: number;
  minJudgedPrecision?: number;
}): ReviewEvalSummary {
  const expectedCount = params.cases.reduce((sum, item) => sum + item.expectedCount, 0);
  const expectedMatched = params.cases.reduce((sum, item) => sum + item.expectedMatched, 0);
  const falsePositiveCount = params.cases.reduce((sum, item) => sum + item.falsePositiveCount, 0);
  const falsePositiveMatched = params.cases.reduce(
    (sum, item) => sum + item.falsePositiveMatched,
    0
  );
  const recall = expectedCount > 0 ? expectedMatched / expectedCount : null;
  const judgedPrecision =
    expectedMatched + falsePositiveMatched > 0
      ? expectedMatched / (expectedMatched + falsePositiveMatched)
      : null;
  const failures: string[] = [];
  if (typeof params.minRecall === "number" && (recall ?? 0) < params.minRecall) {
    failures.push(`recall=${(recall ?? 0).toFixed(4)} below ${params.minRecall}`);
  }
  if (
    typeof params.minJudgedPrecision === "number" &&
    (judgedPrecision ?? 0) < params.minJudgedPrecision
  ) {
    failures.push(
      `judgedPrecision=${(judgedPrecision ?? 0).toFixed(4)} below ${params.minJudgedPrecision}`
    );
  }

  return {
    caseCount: params.cases.length,
    expectedCount,
    expectedMatched,
    falsePositiveCount,
    falsePositiveMatched,
    recall,
    judgedPrecision,
    thresholdStatus: {
      pass: failures.length === 0,
      failures
    },
    cases: params.cases
  };
}
