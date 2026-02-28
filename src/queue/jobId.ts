import crypto from "crypto";

function sanitizeJobToken(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
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
