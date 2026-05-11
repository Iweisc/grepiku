const DEFAULT_READ_FILE_BYTES = 20_000;
const MAX_READ_FILE_BYTES = 200_000;
const DEFAULT_SEARCH_MAX_RESULTS = 50;
const MAX_SEARCH_MAX_RESULTS = 200;
const MAX_SEARCH_MATCH_COLUMNS = 400;

export function normalizeReadonlyReadBytes(value) {
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_READ_FILE_BYTES;
  }
  return Math.min(value, MAX_READ_FILE_BYTES);
}

export function normalizeReadonlySearchMaxResults(value) {
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_SEARCH_MAX_RESULTS;
  }
  return Math.min(value, MAX_SEARCH_MAX_RESULTS);
}

export function buildReadonlySearchArgs(params) {
  const args = [
    "--json",
    "--color",
    "never",
    "--max-count",
    String(normalizeReadonlySearchMaxResults(params.maxResults)),
    "--max-columns",
    String(MAX_SEARCH_MATCH_COLUMNS),
    "--max-columns-preview"
  ];
  if (params.glob) {
    args.push("--glob", params.glob);
  }
  if (Array.isArray(params.extraGlobs)) {
    for (const glob of params.extraGlobs) {
      if (typeof glob === "string" && glob.trim().length > 0) {
        args.push("--glob", glob);
      }
    }
  }
  args.push("--", params.query, params.searchRoot);
  return args;
}

export function createReadonlySearchCollector(params) {
  const maxResults = normalizeReadonlySearchMaxResults(params?.maxResults);
  const lines = [];
  let buffered = "";
  let reachedLimit = false;
  const includeMatch =
    typeof params?.includeMatch === "function" ? params.includeMatch : () => true;

  function textFromJsonField(value) {
    if (!value || typeof value !== "object") {
      return "";
    }
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.bytes === "string") {
      return Buffer.from(value.bytes, "base64").toString("utf8");
    }
    return "";
  }

  function pushJsonLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed?.type !== "match" || !parsed?.data) {
      return;
    }

    const path = textFromJsonField(parsed.data.path);
    const lineNumber = Number(parsed.data.line_number);
    const text = textFromJsonField(parsed.data.lines).replace(/\r?\n$/, "");
    if (!path || !Number.isInteger(lineNumber) || lineNumber <= 0) {
      return;
    }
    if (!includeMatch({ path, lineNumber, text })) {
      return;
    }
    lines.push(`${path}:${lineNumber}:${text}`);
  }

  function pushChunk(chunk) {
    if (reachedLimit) {
      return true;
    }

    buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);

    while (!reachedLimit) {
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
      buffered = buffered.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      pushJsonLine(line);
      if (lines.length >= maxResults) {
        reachedLimit = true;
      }
    }

    return reachedLimit;
  }

  function finish() {
    if (!reachedLimit) {
      const tail = buffered.replace(/\r$/, "").trim();
      if (tail) {
        pushJsonLine(tail);
      }
    }
    if (lines.length > maxResults) {
      lines.length = maxResults;
    }
    buffered = "";
    return lines.join("\n");
  }

  return {
    pushChunk,
    finish
  };
}
