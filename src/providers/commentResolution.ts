export function isResolutionReply(body: string): boolean {
  const normalized = body.toLowerCase();
  const hasResolutionWord = /\b(fixed|resolved|done)\b/.test(normalized);
  if (!hasResolutionWord) return false;
  const negatedResolution = /\b(not|isn['’]?t|wasn['’]?t)\s+(?:yet\s+)?(fixed|resolved|done)\b/.test(
    normalized
  );
  return !negatedResolution;
}
