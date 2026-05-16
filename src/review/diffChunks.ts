import { normalizeDiffPath, normalizePath, parsePatch } from "./diff.js";
import type { ContextPack } from "./context.js";
import type { ReviewComment, ReviewOutput } from "./schemas.js";
import { classifyChangedFileRisk } from "./risk.js";

export type ReviewChunkRisk = "low" | "medium" | "high";

export type ReviewChunkChangedFile = {
  filename?: string;
  path?: string;
  status?: string;
  additions?: number;
  deletions?: number;
};

export type ReviewDiffChunk = {
  id: string;
  ordinal: number;
  paths: string[];
  diffPatch: string;
  changedFiles: ReviewChunkChangedFile[];
  changedLines: number;
  additions: number;
  deletions: number;
  risk: ReviewChunkRisk;
};

export type ReviewDiffChunkPlan = {
  chunks: ReviewDiffChunk[];
  stats: {
    totalFiles: number;
    chunkedFiles: number;
    totalChangedLines: number;
    targetChangedLines: number;
    maxChangedLines: number;
    highRiskTargetChangedLines: number;
    highRiskMaxChangedLines: number;
    maxFiles: number;
    largestFileChangedLines: number;
  };
};

export type ReviewChunkDraft = {
  chunk: ReviewDiffChunk;
  review: ReviewOutput;
};

type DiffFileSection = {
  path: string;
  section: string;
  additions: number;
  deletions: number;
  changedLines: number;
};

const DEFAULT_TARGET_CHANGED_LINES = 8_000;
const DEFAULT_MAX_CHANGED_LINES = 10_000;
const DEFAULT_MAX_FILES = 64;
const RISK_SCORE: Record<ReviewChunkRisk, number> = {
  low: 1,
  medium: 2,
  high: 3
};
const FEATURE_AFFINITY_RANK: Record<string, number> = {
  "feature:infra-security": 0,
  "feature:client-security": 1,
  "feature:conversation-thread": 2,
  "feature:assistant-chat": 3,
  "feature:org-security": 4,
  "feature:session": 5
};

function maxRisk(values: ReviewChunkRisk[]): ReviewChunkRisk {
  return values.reduce<ReviewChunkRisk>(
    (highest, value) => (RISK_SCORE[value] > RISK_SCORE[highest] ? value : highest),
    "low"
  );
}

function normalizeReviewPath(value: string): string {
  return normalizeDiffPath(normalizePath(value));
}

function moduleKey(filePath: string): string {
  const parts = normalizeReviewPath(filePath).split("/").filter(Boolean);
  if (parts.length === 0) return "";
  if ((parts[0] === "apps" || parts[0] === "packages") && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function featureAffinityKey(filePath: string): string {
  const normalized = normalizeReviewPath(filePath).toLowerCase();
  const fileName = normalized.split("/").pop() || normalized;
  if (
    /(dockerfile|docker-compose|patroni|pgbouncer|rabbitmq)/.test(fileName) ||
    /\/(deploy|deployment|infra|ops)\//.test(normalized)
  ) {
    return "feature:infra-security";
  }
  if (/\/\.auth\/state\.json$/.test(normalized) || /\/(background|content)\.(ts|tsx|js|jsx)$/.test(normalized)) {
    return "feature:client-security";
  }
  if (/(conversation|thread)/.test(fileName)) {
    return "feature:conversation-thread";
  }
  if (/\/src\/chat\/controllers\/[^/]*chat[^/]*\.(go|ts|tsx|js|jsx)$/.test(normalized)) {
    return "feature:assistant-chat";
  }
  if (/(session|event|recording|replay|rrweb)/.test(fileName) || /\/sessions?\//.test(normalized)) {
    return "feature:session";
  }
  if (/(organization|project|member|api_key|secret_key|security_event)/.test(fileName)) {
    return "feature:org-security";
  }
  return "";
}

function featureAffinityRank(value: string): number {
  return FEATURE_AFFINITY_RANK[value] ?? 99;
}

function pathForChangedFile(file: ReviewChunkChangedFile): string {
  return normalizeReviewPath(file.filename || file.path || "");
}

function splitDiffSections(diffPatch: string): string[] {
  const starts: number[] = [];
  const regex = /^diff --git /gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(diffPatch)) !== null) {
    starts.push(match.index);
  }
  if (starts.length === 0) return [];

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? diffPatch.length;
    const section = diffPatch.slice(start, end).trimEnd();
    return `${section}\n`;
  });
}

function countSectionChanges(section: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of section.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function parseSectionPath(section: string): string {
  const parsed = parsePatch(section);
  const file = parsed[0];
  if (!file) return "";
  const rawPath = file.to && file.to !== "/dev/null" ? file.to : file.from || "";
  return normalizeReviewPath(rawPath);
}

function splitDiffByFile(diffPatch: string): DiffFileSection[] {
  return splitDiffSections(diffPatch)
    .map((section) => {
      const path = parseSectionPath(section);
      if (!path) return null;
      const { additions, deletions } = countSectionChanges(section);
      return {
        path,
        section,
        additions,
        deletions,
        changedLines: additions + deletions
      };
    })
    .filter((value): value is DiffFileSection => Boolean(value));
}

function changedFileByPath(changedFiles: ReviewChunkChangedFile[]): Map<string, ReviewChunkChangedFile> {
  const map = new Map<string, ReviewChunkChangedFile>();
  for (const file of changedFiles) {
    const key = pathForChangedFile(file);
    if (!key || map.has(key)) continue;
    map.set(key, file);
  }
  return map;
}

function statByPath(
  changedFileStats: ContextPack["changedFileStats"] | undefined
): Map<string, ContextPack["changedFileStats"][number]> {
  const map = new Map<string, ContextPack["changedFileStats"][number]>();
  for (const stat of changedFileStats || []) {
    const key = normalizeReviewPath(stat.path);
    if (!key || map.has(key)) continue;
    map.set(key, stat);
  }
  return map;
}

function chunkId(ordinal: number): string {
  return `chunk-${String(ordinal + 1).padStart(2, "0")}`;
}

export function buildReviewDiffChunkPlan(params: {
  diffPatch: string;
  changedFiles: ReviewChunkChangedFile[];
  changedFileStats?: ContextPack["changedFileStats"];
  targetChangedLines?: number;
  maxChangedLines?: number;
  highRiskTargetChangedLines?: number;
  highRiskMaxChangedLines?: number;
  maxFiles?: number;
}): ReviewDiffChunkPlan {
  const targetChangedLines = Math.max(1, Math.floor(params.targetChangedLines ?? DEFAULT_TARGET_CHANGED_LINES));
  const maxChangedLines = Math.max(targetChangedLines, Math.floor(params.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES));
  const highRiskTargetChangedLines = Math.max(
    1,
    Math.floor(params.highRiskTargetChangedLines ?? targetChangedLines)
  );
  const highRiskMaxChangedLines = Math.max(
    highRiskTargetChangedLines,
    Math.floor(params.highRiskMaxChangedLines ?? maxChangedLines)
  );
  const maxFiles = Math.max(1, Math.floor(params.maxFiles ?? DEFAULT_MAX_FILES));
  const metadata = changedFileByPath(params.changedFiles);
  const stats = statByPath(params.changedFileStats);
  const sections = splitDiffByFile(params.diffPatch).map((section) => {
    const file = metadata.get(section.path);
    const stat = stats.get(section.path);
    const additions = section.additions || file?.additions || stat?.additions || 0;
    const deletions = section.deletions || file?.deletions || stat?.deletions || 0;
    const changedLines = Math.max(section.changedLines, additions + deletions);
    const risk = stat?.risk || classifyChangedFileRisk({ path: section.path, additions, deletions });
    return {
      ...section,
      additions,
      deletions,
      changedLines,
      risk,
      changedFile: file || {
        path: section.path,
        additions,
        deletions,
        status: stat?.status
      }
    };
  });

  const sorted = [...sections].sort((a, b) => {
    const riskDelta = RISK_SCORE[b.risk] - RISK_SCORE[a.risk];
    if (riskDelta !== 0) return riskDelta;
    const affinityA = featureAffinityKey(a.path);
    const affinityB = featureAffinityKey(b.path);
    if (affinityA || affinityB) {
      if (!affinityA) return 1;
      if (!affinityB) return -1;
      const affinityDelta = featureAffinityRank(affinityA) - featureAffinityRank(affinityB);
      if (affinityDelta !== 0) return affinityDelta;
    }
    const moduleDelta = moduleKey(a.path).localeCompare(moduleKey(b.path));
    if (moduleDelta !== 0) return moduleDelta;
    const churnDelta = b.changedLines - a.changedLines;
    if (churnDelta !== 0) return churnDelta;
    return a.path.localeCompare(b.path);
  });

  const buckets: Array<typeof sorted> = [];
  let current: typeof sorted = [];
  let currentChangedLines = 0;
  let currentAffinity = "";
  for (const section of sorted) {
    const sectionAffinity = featureAffinityKey(section.path);
    const nextRisk = maxRisk([...current.map((item) => item.risk), section.risk]);
    const targetForBucket = nextRisk === "high" ? highRiskTargetChangedLines : targetChangedLines;
    const maxForBucket = nextRisk === "high" ? highRiskMaxChangedLines : maxChangedLines;
    const wouldExceed = current.length > 0 && currentChangedLines + section.changedLines > targetForBucket;
    const hardLimitExceeded = current.length > 0 && currentChangedLines >= maxForBucket;
    const fileLimitExceeded = current.length >= maxFiles;
    const highAffinityBoundary =
      current.length > 0 &&
      nextRisk === "high" &&
      Boolean(currentAffinity) &&
      Boolean(sectionAffinity) &&
      currentAffinity !== sectionAffinity;
    if (wouldExceed || hardLimitExceeded || fileLimitExceeded || highAffinityBoundary) {
      buckets.push(current);
      current = [];
      currentChangedLines = 0;
      currentAffinity = "";
    }
    current.push(section);
    currentChangedLines += section.changedLines;
    if (!currentAffinity && sectionAffinity) {
      currentAffinity = sectionAffinity;
    }
  }
  if (current.length > 0) buckets.push(current);

  const chunks = buckets.map<ReviewDiffChunk>((bucket, ordinal) => {
    const additions = bucket.reduce((sum, section) => sum + section.additions, 0);
    const deletions = bucket.reduce((sum, section) => sum + section.deletions, 0);
    return {
      id: chunkId(ordinal),
      ordinal,
      paths: bucket.map((section) => section.path),
      diffPatch: bucket.map((section) => section.section).join(""),
      changedFiles: bucket.map((section) => section.changedFile),
      changedLines: additions + deletions,
      additions,
      deletions,
      risk: maxRisk(bucket.map((section) => section.risk))
    };
  });

  return {
    chunks,
    stats: {
      totalFiles: params.changedFiles.length,
      chunkedFiles: sections.length,
      totalChangedLines: sections.reduce((sum, section) => sum + section.changedLines, 0),
      targetChangedLines,
      maxChangedLines,
      highRiskTargetChangedLines,
      highRiskMaxChangedLines,
      maxFiles,
      largestFileChangedLines: sections.reduce(
        (largest, section) => Math.max(largest, section.changedLines),
        0
      )
    }
  };
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

function truncateSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildMergedChunkOverview(params: {
  drafts: ReviewChunkDraft[];
  comments: ReviewComment[];
}): string {
  const topFindings = uniqueStrings(params.comments.map((comment) => comment.title), 3).map((value) =>
    truncateSingleLine(value, 110)
  );
  if (topFindings.length > 0) {
    return truncateSingleLine(`Top review findings: ${topFindings.join("; ")}.`, 400);
  }

  const keyConcerns = uniqueStrings(
    params.drafts.flatMap(({ review }) => review.summary.key_concerns || []),
    2
  ).map((value) => truncateSingleLine(value, 120));
  if (keyConcerns.length > 0) {
    return truncateSingleLine(`Key concerns: ${keyConcerns.join("; ")}.`, 320);
  }

  return "Review completed with no high-confidence findings.";
}

function chunkCommentId(chunk: ReviewDiffChunk, comment: ReviewComment): string {
  const rawId = comment.comment_id.trim() || comment.comment_key.trim() || "comment";
  return `${chunk.id}:${rawId}`;
}

export function mergeChunkReviewDrafts(params: {
  drafts: ReviewChunkDraft[];
  maxKeyConcerns: number;
}): ReviewOutput {
  const comments = params.drafts.flatMap(({ chunk, review }) =>
    review.comments.map((comment) => ({
      ...comment,
      comment_id: chunkCommentId(chunk, comment),
      comment_key: `${chunk.id}:${comment.comment_key || comment.comment_id}`
    }))
  );
  const summaries = params.drafts.map((draft) => draft.review.summary);
  const fileBreakdown = params.drafts.flatMap(({ review }) => review.summary.file_breakdown || []);
  const confidenceValues = summaries
    .map((summary) => summary.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const overview = buildMergedChunkOverview({ drafts: params.drafts, comments });

  return {
    summary: {
      overview,
      risk: maxRisk(summaries.map((summary) => summary.risk)),
      confidence: confidenceValues.length > 0 ? Math.min(...confidenceValues) : undefined,
      key_concerns: uniqueStrings(
        summaries.flatMap((summary) => summary.key_concerns),
        params.maxKeyConcerns
      ),
      what_to_test: uniqueStrings(
        summaries.flatMap((summary) => summary.what_to_test),
        Math.max(params.maxKeyConcerns, 12)
      ),
      file_breakdown: fileBreakdown
    },
    comments
  };
}

export const __diffChunkInternals = {
  splitDiffByFile,
  splitDiffSections
};
