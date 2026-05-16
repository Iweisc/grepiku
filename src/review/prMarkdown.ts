const MAX_PR_MARKDOWN_TITLE_CHARS = 300;
const MAX_PR_MARKDOWN_BODY_CHARS = 12_000;
const MAX_PR_MARKDOWN_METADATA_CHARS = 300;
const MAX_SENSITIVE_PATHS_WITHHELD = 50;

function normalizeSingleLine(
  value: string | null | undefined,
  fallback: string,
  maxChars: number,
  label: string
): string {
  const normalized = (value || fallback)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return fallback;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()} [${label} truncated]`;
}

function normalizeMultiline(
  value: string | null | undefined,
  fallback: string,
  maxChars: number,
  label: string
): string {
  const normalized = (value || fallback).replace(/\r\n/g, "\n").trim();
  if (!normalized) return fallback;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n[${label} truncated]`;
}

export function renderPrMarkdown(params: {
  title: string;
  number: number;
  author: string;
  body?: string | null;
  baseRef?: string | null;
  headRef?: string | null;
  headSha: string;
  url?: string | null;
  sensitivePathsWithheld?: string[];
}): string {
  const title = normalizeSingleLine(
    params.title,
    "Untitled",
    MAX_PR_MARKDOWN_TITLE_CHARS,
    "pr title"
  );
  const author = normalizeSingleLine(
    params.author,
    "unknown",
    MAX_PR_MARKDOWN_METADATA_CHARS,
    "author"
  );
  const baseRef = normalizeSingleLine(
    params.baseRef,
    "",
    MAX_PR_MARKDOWN_METADATA_CHARS,
    "base ref"
  );
  const headRef = normalizeSingleLine(
    params.headRef,
    "",
    MAX_PR_MARKDOWN_METADATA_CHARS,
    "head ref"
  );
  const headSha = normalizeSingleLine(
    params.headSha,
    "",
    MAX_PR_MARKDOWN_METADATA_CHARS,
    "head sha"
  );
  const url = normalizeSingleLine(
    params.url,
    "",
    2_000,
    "url"
  );
  const body = normalizeMultiline(
    params.body,
    "(no description)",
    MAX_PR_MARKDOWN_BODY_CHARS,
    "pr description"
  );
  const sensitivePaths = Array.from(
    new Set(
      (params.sensitivePathsWithheld || [])
        .map((value) => normalizeSingleLine(value, "", MAX_PR_MARKDOWN_METADATA_CHARS, "path"))
        .filter((value) => value.length > 0)
    )
  );
  const shownSensitivePaths = sensitivePaths.slice(0, MAX_SENSITIVE_PATHS_WITHHELD);
  const remainingSensitivePathCount = Math.max(
    0,
    sensitivePaths.length - shownSensitivePaths.length
  );
  const sensitiveSection =
    shownSensitivePaths.length > 0
      ? [
          "",
          "## Sensitive Files Withheld",
          "The following changed paths match secret or credential-store conventions. Their contents are intentionally omitted from model-visible review context.",
          ...shownSensitivePaths.map((value) => `- ${value}`),
          ...(remainingSensitivePathCount > 0
            ? [`- [${remainingSensitivePathCount} additional sensitive path(s) withheld]`]
            : [])
        ].join("\n")
      : "";

  return `# PR #${params.number}: ${title}

Author: ${author}
Base: ${baseRef}
Head: ${headRef}
Head SHA: ${headSha}
URL: ${url}

## Description
${body}${sensitiveSection}
`;
}
