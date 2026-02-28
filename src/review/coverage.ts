import { normalizePath } from "./diff.js";
import type { ReviewComment, ReviewOutput } from "./schemas.js";

export type CoverageTarget = {
  path: string;
  risk: "low" | "medium" | "high";
  additions?: number;
  deletions?: number;
  reason: string;
};

export type CoveragePlan = {
  shouldRun: boolean;
  targets: CoverageTarget[];
  stats: {
    totalChanged: number;
    coveredChanged: number;
    uncoveredChanged: number;
    coverageRatio: number;
    findingsOnChanged: number;
    minExpectedFindings: number;
  };
};

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function riskRank(risk: CoverageTarget["risk"]): number {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  return 1;
}

function baseReason(target: {
  risk: CoverageTarget["risk"];
  additions?: number;
  deletions?: number;
}): string {
  const churn = (target.additions || 0) + (target.deletions || 0);
  if (target.risk === "high") return `high churn (${churn} lines changed)`;
  if (target.risk === "medium") return `medium churn (${churn} lines changed)`;
  return churn > 0 ? `uncovered changed file (${churn} lines changed)` : "uncovered changed file";
}

function isInlineCoverageFinding(comment: ReviewComment): boolean {
  const type = comment.comment_type || "inline";
  if (type !== "inline") return false;
  if (comment.category === "style" && comment.severity === "nit") return false;
  if (comment.confidence === "low" && comment.severity === "nit") return false;
  return true;
}

export function buildCoveragePlan(params: {
  changedFiles: Array<{
    path?: string;
    filename?: string;
    additions?: number;
    deletions?: number;
  }>;
  changedFileStats?: Array<{
    path: string;
    risk: "low" | "medium" | "high";
    additions?: number;
    deletions?: number;
  }>;
  comments: ReviewComment[];
  maxTargets?: number;
}): CoveragePlan {
  const changedByPath = new Map<
    string,
    { additions?: number; deletions?: number; risk: "low" | "medium" | "high" }
  >();

  for (const file of params.changedFiles) {
    const path = normalizePath(file.path || file.filename || "");
    if (!path) continue;
    const existing = changedByPath.get(path);
    const additions = typeof file.additions === "number" ? file.additions : existing?.additions;
    const deletions = typeof file.deletions === "number" ? file.deletions : existing?.deletions;
    const churn = (additions || 0) + (deletions || 0);
    const risk: "low" | "medium" | "high" =
      churn >= 250 ? "high" : churn >= 80 ? "medium" : existing?.risk || "low";
    changedByPath.set(path, { additions, deletions, risk });
  }

  for (const stat of params.changedFileStats || []) {
    const path = normalizePath(stat.path || "");
    if (!path || !changedByPath.has(path)) continue;
    const existing = changedByPath.get(path)!;
    changedByPath.set(path, {
      additions: stat.additions ?? existing.additions,
      deletions: stat.deletions ?? existing.deletions,
      risk: stat.risk || existing.risk
    });
  }

  const changedPaths = [...changedByPath.keys()];
  if (changedPaths.length === 0) {
    return {
      shouldRun: false,
      targets: [],
      stats: {
        totalChanged: 0,
        coveredChanged: 0,
        uncoveredChanged: 0,
        coverageRatio: 1,
        findingsOnChanged: 0,
        minExpectedFindings: 0
      }
    };
  }

  const changedPathSet = new Set(changedPaths);
  const coveredPathSet = new Set<string>();
  let findingsOnChanged = 0;

  for (const comment of params.comments) {
    if (!isInlineCoverageFinding(comment)) continue;
    const path = normalizePath(comment.path);
    if (!changedPathSet.has(path)) continue;
    findingsOnChanged += 1;
    coveredPathSet.add(path);
  }

  const coveredChanged = coveredPathSet.size;
  const uncovered = changedPaths.filter((path) => !coveredPathSet.has(path));
  const uncoveredChanged = uncovered.length;
  const coverageRatio = coveredChanged / changedPaths.length;
  const minExpectedFindings = Math.min(6, Math.max(2, Math.ceil(changedPaths.length * 0.5)));

  const shouldRun =
    changedPaths.length >= 2 &&
    uncoveredChanged > 0 &&
    (coverageRatio < 0.75 || findingsOnChanged < minExpectedFindings);

  const maxTargets = Math.max(2, Math.min(16, params.maxTargets ?? 8));
  const targets = uncovered
    .map((path) => {
      const meta = changedByPath.get(path)!;
      return {
        path,
        risk: meta.risk,
        additions: meta.additions,
        deletions: meta.deletions,
        reason: baseReason(meta),
        score: riskRank(meta.risk) * 100 + Math.min(99, (meta.additions || 0) + (meta.deletions || 0))
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxTargets)
    .map(({ score: _score, ...target }) => target);

  return {
    shouldRun,
    targets,
    stats: {
      totalChanged: changedPaths.length,
      coveredChanged,
      uncoveredChanged,
      coverageRatio,
      findingsOnChanged,
      minExpectedFindings
    }
  };
}

export function mergeSupplementalComments(params: {
  base: ReviewComment[];
  supplemental: ReviewComment[];
}): {
  comments: ReviewComment[];
  added: number;
  droppedDuplicates: number;
  droppedLowValue: number;
} {
  const comments = [...params.base];
  const strictKeys = new Set<string>();
  const semanticLines = new Map<string, number[]>();

  const strictKeyFor = (comment: ReviewComment) =>
    [
      normalizePath(comment.path),
      comment.side,
      comment.line,
      comment.category,
      normalizeTitle(comment.title)
    ].join("|");
  const semanticKeyFor = (comment: ReviewComment) =>
    [normalizePath(comment.path), comment.category, normalizeTitle(comment.title)].join("|");

  const hasNearbySemanticDuplicate = (key: string, line: number): boolean => {
    const lines = semanticLines.get(key) || [];
    return lines.some((existingLine) => Math.abs(existingLine - line) <= 8);
  };

  const addSemanticLine = (key: string, line: number) => {
    const lines = semanticLines.get(key) || [];
    lines.push(line);
    semanticLines.set(key, lines);
  };

  for (const comment of comments) {
    strictKeys.add(strictKeyFor(comment));
    addSemanticLine(semanticKeyFor(comment), comment.line);
  }

  let added = 0;
  let droppedDuplicates = 0;
  let droppedLowValue = 0;
  for (const comment of params.supplemental) {
    if (comment.category === "style" && comment.severity === "nit") {
      droppedLowValue += 1;
      continue;
    }
    if (comment.confidence === "low" && comment.severity === "nit") {
      droppedLowValue += 1;
      continue;
    }
    const strictKey = strictKeyFor(comment);
    const semanticKey = semanticKeyFor(comment);
    if (strictKeys.has(strictKey) || hasNearbySemanticDuplicate(semanticKey, comment.line)) {
      droppedDuplicates += 1;
      continue;
    }
    strictKeys.add(strictKey);
    addSemanticLine(semanticKey, comment.line);
    comments.push(comment);
    added += 1;
  }

  return { comments, added, droppedDuplicates, droppedLowValue };
}

function riskLevelValue(risk: ReviewOutput["summary"]["risk"]): number {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  return 1;
}

export function mergeSupplementalSummary(params: {
  base: ReviewOutput["summary"];
  supplemental: ReviewOutput["summary"];
  maxKeyConcerns: number;
}): ReviewOutput["summary"] {
  const mergedRisk =
    riskLevelValue(params.supplemental.risk) > riskLevelValue(params.base.risk)
      ? params.supplemental.risk
      : params.base.risk;

  const keyConcerns = Array.from(
    new Set([...params.base.key_concerns, ...params.supplemental.key_concerns].map((value) => value.trim()).filter(Boolean))
  ).slice(0, Math.max(1, params.maxKeyConcerns));

  const whatToTest = Array.from(
    new Set([...params.base.what_to_test, ...params.supplemental.what_to_test].map((value) => value.trim()).filter(Boolean))
  ).slice(0, Math.max(4, params.maxKeyConcerns * 2));

  const byPath = new Map<string, { path: string; summary: string; risk?: "low" | "medium" | "high" }>();
  for (const file of params.base.file_breakdown || []) {
    byPath.set(normalizePath(file.path), file);
  }
  for (const file of params.supplemental.file_breakdown || []) {
    const key = normalizePath(file.path);
    if (!byPath.has(key)) {
      byPath.set(key, file);
      continue;
    }
    const existing = byPath.get(key)!;
    byPath.set(key, {
      path: existing.path,
      summary: existing.summary.length >= file.summary.length ? existing.summary : file.summary,
      risk:
        file.risk && existing.risk
          ? riskLevelValue(file.risk) > riskLevelValue(existing.risk)
            ? file.risk
            : existing.risk
          : existing.risk || file.risk
    });
  }

  return {
    ...params.base,
    risk: mergedRisk,
    confidence:
      params.base.confidence !== undefined && params.supplemental.confidence !== undefined
        ? Math.min(params.base.confidence, params.supplemental.confidence)
        : params.base.confidence ?? params.supplemental.confidence,
    key_concerns: keyConcerns,
    what_to_test: whatToTest,
    file_breakdown: Array.from(byPath.values()),
    diagram_mermaid: params.base.diagram_mermaid || params.supplemental.diagram_mermaid
  };
}
