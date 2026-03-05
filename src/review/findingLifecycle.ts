import { normalizePath } from "./diff.js";

function normalizeFindingTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function semanticFindingKey(pathValue: string, category: string, title: string): string {
  return `${normalizePath(pathValue)}|${category}|${normalizeFindingTitle(title)}`;
}

export function selectPreferredExactKeyFinding<T extends { status: string }>(
  current: T | undefined,
  candidate: T
): T {
  if (!current || current.status !== "open") {
    return candidate;
  }
  return current;
}

export type OpenFindingLifecycleState = {
  id: number;
  path: string;
  category: string;
  title: string;
  reviewRunId: number;
  lastSeenRunId: number | null;
};

export function selectFixedFindingCandidates<T extends OpenFindingLifecycleState>(params: {
  existingOpen: T[];
  matchedOldIds: Set<number>;
  incomingSemanticKeys: Set<string>;
  incrementalReview: boolean;
  changedPathSet: Set<string>;
  currentHeadSha: string;
  headShaByRunId: Map<number, string>;
}): T[] {
  const {
    existingOpen,
    matchedOldIds,
    incomingSemanticKeys,
    incrementalReview,
    changedPathSet,
    currentHeadSha,
    headShaByRunId
  } = params;

  return existingOpen.filter((finding) => {
    if (matchedOldIds.has(finding.id)) return false;
    if (incomingSemanticKeys.has(semanticFindingKey(finding.path, finding.category, finding.title))) return false;

    const seenRunId = finding.lastSeenRunId || finding.reviewRunId;
    const seenHeadSha = headShaByRunId.get(seenRunId);
    if (seenHeadSha && seenHeadSha === currentHeadSha) return false;

    if (!incrementalReview) return true;
    return changedPathSet.has(normalizePath(finding.path));
  });
}
