import { ReviewSchema } from "./schemas.js";

type PreviousRunSnapshot = {
  id: number;
  headSha: string;
  trigger: string;
  completedAt: Date | null;
  finalJson: unknown;
  summaryJson: unknown;
};

type OpenFindingSnapshot = {
  path: string;
  line: number;
  severity: string;
  category: string;
  title: string;
  body: string;
  ruleId?: string | null;
  ruleReason?: string | null;
};

export type IncrementalReviewContext = {
  previous_run: {
    id: number;
    head_sha: string;
    trigger: string;
    completed_at: string | null;
    summary: {
      risk: string | null;
      confidence: number | null;
      file_paths: string[];
    } | null;
    comments: Array<{
      path: string;
      line: number;
      severity: string;
      category: string;
      comment_type: string;
      confidence?: string;
    }>;
  };
  carried_open_findings: Array<{
    path: string;
    line: number;
    severity: string;
    category: string;
  }>;
};

const severityOrder = new Map([
  ["blocking", 0],
  ["important", 1],
  ["nit", 2]
]);

function severityRank(value: string): number {
  return severityOrder.get(value) ?? 9;
}

const MAX_INCREMENTAL_PATH_CHARS = 240;

function sanitizeHistoricalPath(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_INCREMENTAL_PATH_CHARS)
    .trim();
}

function summarizePreviousSummary(value: unknown): IncrementalReviewContext["previous_run"]["summary"] {
  const parsedSummary = ReviewSchema.shape.summary.safeParse(value);
  if (!parsedSummary.success) {
    return null;
  }

  const filePaths = Array.from(
    new Set(
      (parsedSummary.data.file_breakdown || [])
        .map((item) => sanitizeHistoricalPath(item.path))
        .filter((item) => item.length > 0)
    )
  ).slice(0, 40);

  return {
    risk: parsedSummary.data.risk,
    confidence:
      typeof parsedSummary.data.confidence === "number" ? parsedSummary.data.confidence : null,
    file_paths: filePaths
  };
}

function parsePreviousRun(previousRun: PreviousRunSnapshot): {
  summary: IncrementalReviewContext["previous_run"]["summary"];
  comments: IncrementalReviewContext["previous_run"]["comments"];
} {
  const parsedFinal = ReviewSchema.safeParse(previousRun.finalJson);
  if (parsedFinal.success) {
    return {
      summary: summarizePreviousSummary(parsedFinal.data.summary),
      comments: parsedFinal.data.comments.slice(0, 60).map((comment) => ({
        path: sanitizeHistoricalPath(comment.path),
        line: comment.line,
        severity: comment.severity,
        category: comment.category,
        comment_type: comment.comment_type || "inline",
        confidence: comment.confidence
      })).filter((comment) => comment.path.length > 0)
    };
  }

  return {
    summary: summarizePreviousSummary(previousRun.summaryJson),
    comments: []
  };
}

export function buildIncrementalReviewContext(params: {
  previousRun: PreviousRunSnapshot | null;
  openFindings: OpenFindingSnapshot[];
}): IncrementalReviewContext | null {
  const { previousRun, openFindings } = params;
  if (!previousRun) return null;

  const previous = parsePreviousRun(previousRun);
  const carriedOpenFindings = [...openFindings]
    .sort((a, b) => {
      const severityDiff = severityRank(a.severity) - severityRank(b.severity);
      if (severityDiff !== 0) return severityDiff;
      const pathDiff = sanitizeHistoricalPath(a.path).localeCompare(sanitizeHistoricalPath(b.path));
      if (pathDiff !== 0) return pathDiff;
      if (a.line !== b.line) return a.line - b.line;
      return a.category.localeCompare(b.category);
    })
    .slice(0, 80)
    .map((finding) => ({
      path: sanitizeHistoricalPath(finding.path),
      line: finding.line,
      severity: finding.severity,
      category: finding.category
    }))
    .filter((finding) => finding.path.length > 0);

  return {
    previous_run: {
      id: previousRun.id,
      head_sha: previousRun.headSha,
      trigger: previousRun.trigger,
      completed_at: previousRun.completedAt ? previousRun.completedAt.toISOString() : null,
      summary: previous.summary,
      comments: previous.comments
    },
    carried_open_findings: carriedOpenFindings
  };
}
