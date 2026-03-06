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
    summary: unknown;
    comments: Array<{
      path: string;
      line: number;
      severity: string;
      category: string;
      title: string;
      body: string;
      comment_type: string;
      confidence?: string;
    }>;
  };
  carried_open_findings: Array<{
    path: string;
    line: number;
    severity: string;
    category: string;
    title: string;
    body: string;
    rule_id?: string;
    rule_reason?: string;
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

function parsePreviousRun(previousRun: PreviousRunSnapshot): {
  summary: unknown;
  comments: IncrementalReviewContext["previous_run"]["comments"];
} {
  const parsedFinal = ReviewSchema.safeParse(previousRun.finalJson);
  if (parsedFinal.success) {
    return {
      summary: parsedFinal.data.summary,
      comments: parsedFinal.data.comments.slice(0, 60).map((comment) => ({
        path: comment.path,
        line: comment.line,
        severity: comment.severity,
        category: comment.category,
        title: comment.title,
        body: comment.body,
        comment_type: comment.comment_type || "inline",
        confidence: comment.confidence
      }))
    };
  }

  const parsedSummary = ReviewSchema.shape.summary.safeParse(previousRun.summaryJson);
  return {
    summary: parsedSummary.success ? parsedSummary.data : null,
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
      const pathDiff = a.path.localeCompare(b.path);
      if (pathDiff !== 0) return pathDiff;
      if (a.line !== b.line) return a.line - b.line;
      return a.title.localeCompare(b.title);
    })
    .slice(0, 80)
    .map((finding) => ({
      path: finding.path,
      line: finding.line,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      body: finding.body,
      ...(finding.ruleId ? { rule_id: finding.ruleId } : {}),
      ...(finding.ruleReason ? { rule_reason: finding.ruleReason } : {})
    }));

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
