import { normalizePath } from "./diff.js";
import type { ReviewComment } from "./schemas.js";

export type ExistingFindingCandidate = {
  id: number;
  path: string;
  line: number;
  side: string;
  severity: string;
  category: string;
  title: string;
  body: string;
};

const MATCH_NOISE_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "have",
  "has",
  "into",
  "when",
  "where",
  "should",
  "could",
  "would",
  "runs",
  "run"
]);

function tokenizeForFindingMatch(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/\\+n/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return new Set<string>();
  const tokens = normalized
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !MATCH_NOISE_TOKENS.has(token));
  return new Set(tokens);
}

function jaccardScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  const union = left.size + right.size - overlap;
  if (union <= 0) return 0;
  return overlap / union;
}

function lineProximityScore(distance: number): number {
  if (distance <= 2) return 1;
  if (distance <= 6) return 0.9;
  if (distance <= 12) return 0.75;
  if (distance <= 25) return 0.55;
  return 0.3;
}

export function selectSemanticFindingCandidate<T extends ExistingFindingCandidate>(params: {
  comment: ReviewComment;
  candidates: T[];
  matchedIds?: Set<number>;
}): T | undefined {
  const { comment, candidates, matchedIds } = params;
  const filtered = candidates.filter((candidate) => {
    if (matchedIds?.has(candidate.id)) return false;
    return (
      normalizePath(candidate.path) === normalizePath(comment.path) &&
      candidate.category === comment.category
    );
  });
  if (filtered.length === 0) return undefined;

  const commentTitleTokens = tokenizeForFindingMatch(comment.title);
  const commentBodyTokens = tokenizeForFindingMatch(comment.body || "");

  let best: T | undefined;
  let bestScore = 0;

  for (const candidate of filtered) {
    const titleScore = jaccardScore(commentTitleTokens, tokenizeForFindingMatch(candidate.title || ""));
    if (titleScore <= 0) continue;

    const bodyScore = jaccardScore(commentBodyTokens, tokenizeForFindingMatch(candidate.body || ""));
    const lineDistance = Math.abs(candidate.line - comment.line);
    const proximityScore = lineProximityScore(lineDistance);
    const sideScore = candidate.side === comment.side ? 1 : 0.7;
    const severityScore = candidate.severity === comment.severity ? 1 : 0.7;
    const compositeScore =
      titleScore * 0.64 +
      bodyScore * 0.16 +
      proximityScore * 0.14 +
      sideScore * 0.04 +
      severityScore * 0.02;

    const strongTitleMatch = titleScore >= 0.5;
    const closeTitleMatch = titleScore >= 0.34 && lineDistance <= 8;
    if (!strongTitleMatch && !closeTitleMatch) continue;
    if (compositeScore <= bestScore) continue;
    best = candidate;
    bestScore = compositeScore;
  }

  if (!best || bestScore < 0.5) return undefined;
  return best;
}
