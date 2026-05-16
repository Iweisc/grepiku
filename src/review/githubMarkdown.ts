const GITHUB_MENTION_GUARD = "\u200b";
const GITHUB_CLOSING_KEYWORD_PATTERN =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(?=\s+(?:[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*#\d+\b|#\d+\b|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+\b))/gi;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function neutralizeGitHubMentions(value: string): string {
  return normalizeLineEndings(value).replace(
    /(^|[^A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?)/g,
    (_match, prefix: string, mention: string) => `${prefix}@${GITHUB_MENTION_GUARD}${mention}`
  );
}

export function neutralizeGitHubClosingKeywords(value: string): string {
  return normalizeLineEndings(value).replace(
    GITHUB_CLOSING_KEYWORD_PATTERN,
    (match) => `${match[0]}${GITHUB_MENTION_GUARD}${match.slice(1)}`
  );
}

export function neutralizeGitHubIssueReferences(value: string): string {
  return normalizeLineEndings(value)
    .replace(
      /([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)#(\d+)\b/g,
      (_match, repoRef: string, issueNumber: string) =>
        `${repoRef}#${GITHUB_MENTION_GUARD}${issueNumber}`
    )
    .replace(
      /(^|[^A-Za-z0-9_])#(\d+)\b/g,
      (_match, prefix: string, issueNumber: string) =>
        `${prefix}#${GITHUB_MENTION_GUARD}${issueNumber}`
    );
}

export function neutralizeGitHubAutolinkUrls(value: string): string {
  return normalizeLineEndings(value)
    .replace(/\bhttps?:\/\/[^\s<>()]+/gi, (match) =>
      match.replace(/^https?:\/\//i, (scheme) => `${scheme}${GITHUB_MENTION_GUARD}`)
    )
    .replace(/\bmailto:[^\s<>()]+/gi, (match) =>
      match.replace(/^mailto:/i, (scheme) => `${scheme}${GITHUB_MENTION_GUARD}`)
    );
}

export function sanitizeGitHubMarkdownText(value: string): string {
  return neutralizeGitHubAutolinkUrls(
    neutralizeGitHubIssueReferences(
      neutralizeGitHubClosingKeywords(neutralizeGitHubMentions(value))
    )
  )
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}
