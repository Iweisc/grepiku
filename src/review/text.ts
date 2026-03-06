const STRUCTURAL_ESCAPED_TAB_RE = /(^|\n|\\n)\\t+/m;
const UNESCAPED_NEWLINE_ESCAPE_RE = /(?<!\\)(?:\\r\\n|\\n)/;

function parseJsonStringLiteral(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function buildJsonStringLiteral(value: string): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      let backslashCount = 0;
      for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
        backslashCount += 1;
      }
      escaped += backslashCount % 2 === 1 ? '"' : '\\"';
      continue;
    }
    if (char === "\r") {
      escaped += "\\r";
      continue;
    }
    if (char === "\n") {
      escaped += "\\n";
      continue;
    }
    if (char === "\t") {
      escaped += "\\t";
      continue;
    }
    if (char === "\f") {
      escaped += "\\f";
      continue;
    }
    if (char === "\u0008") {
      escaped += "\\b";
      continue;
    }
    escaped += char;
  }
  return `"${escaped}"`;
}

function countFormattingChars(value: string): number {
  return Array.from(value).filter((char) => char === "\n" || char === "\r" || char === "\t").length;
}

function tryDecodeWrappedSuggestion(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;
  const parsed = parseJsonStringLiteral(trimmed);
  if (!parsed) return null;
  const normalized = parsed.replace(/\r\n/g, "\n");
  return countFormattingChars(normalized) > countFormattingChars(trimmed) ? normalized : null;
}

function tryDecodeStructuredSuggestion(value: string): string | null {
  if (!STRUCTURAL_ESCAPED_TAB_RE.test(value)) return null;
  const parsed = parseJsonStringLiteral(buildJsonStringLiteral(value));
  if (!parsed) return null;
  const normalized = parsed.replace(/\r\n/g, "\n");
  return countFormattingChars(normalized) > countFormattingChars(value) ? normalized : null;
}

export function stripEdgeBlankLines(value: string): string {
  return value.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

export function normalizeSuggestedPatchText(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n");
  const decoded = tryDecodeWrappedSuggestion(normalized) || tryDecodeStructuredSuggestion(normalized);
  if (decoded) return decoded;
  if (UNESCAPED_NEWLINE_ESCAPE_RE.test(normalized)) {
    return normalized
      .replace(/(?<!\\)\\r\\n/g, "\n")
      .replace(/(?<!\\)\\n/g, "\n");
  }
  return normalized;
}
