import crypto from "crypto";

function sanitizeJobToken(value: string, maxLength = 80): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
}

export function buildIndexJobId(data: any): string {
  const repoId = sanitizeJobToken(String(data?.repoId ?? "unknown")) || "unknown";
  const patternRepo = data?.patternRepo as { url?: string; ref?: string; name?: string } | undefined;
  const scopeRaw = patternRepo
    ? `pattern:${patternRepo.url || patternRepo.name || "unknown"}:${patternRepo.ref || "HEAD"}`
    : "repo";
  const scope = crypto.createHash("sha1").update(scopeRaw).digest("hex").slice(0, 12);
  const headSha = sanitizeJobToken(String(data?.headSha || "HEAD")) || "HEAD";
  const mode = data?.force ? "force" : "normal";
  return `index_${repoId}_${scope}_${headSha}_${mode}`;
}

export function buildReviewJobId(data: any): string {
  const repoId = sanitizeJobToken(String(data?.repoId ?? "unknown"), 24) || "unknown";
  const pullRequestId = sanitizeJobToken(String(data?.pullRequestId ?? "unknown"), 24) || "unknown";
  const headShaRaw = String(data?.headSha || "HEAD");
  const headSha = sanitizeJobToken(headShaRaw, 40) || crypto.createHash("sha1").update(headShaRaw).digest("hex").slice(0, 12);
  const mode = data?.force ? "force" : "auto";
  return `review_${repoId}_${pullRequestId}_${headSha}_${mode}`;
}
