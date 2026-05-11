import { isTrustedCommentAuthorAssociation } from "../providers/commentGuards.js";

export function feedbackAuthorAssociation(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const value = record.authorAssociation ?? record.author_association;
  return typeof value === "string" ? value : null;
}

export function isTrustedFeedbackMetadata(metadata: unknown): boolean {
  return isTrustedCommentAuthorAssociation(feedbackAuthorAssociation(metadata));
}
