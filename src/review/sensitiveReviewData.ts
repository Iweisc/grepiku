import { shouldSkipSensitivePath } from "../services/indexerPathPolicy.js";
import { normalizeDiffPath, normalizePath } from "./diff.js";

export type ModelVisibleChangedFile = {
  path?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string | null;
  sensitive?: boolean;
  withheld_reason?: string | null;
};

function normalizeChangedPath(value: string | null | undefined): string {
  return normalizePath(value || "");
}

function uniquePaths(paths: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    const normalized = normalizeChangedPath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function splitDiffSections(diffPatch: string): {
  preamble: string[];
  sections: string[][];
} {
  if (!diffPatch) {
    return { preamble: [], sections: [] };
  }
  const lines = diffPatch.split("\n");
  const preamble: string[] = [];
  const sections: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        sections.push(current);
      }
      current = [line];
      continue;
    }

    if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return { preamble, sections };
}

function resolveDiffSectionPath(lines: string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) {
      continue;
    }
    const candidate = line.slice(4).trim();
    if (!candidate || candidate === "/dev/null") {
      continue;
    }
    const normalized = normalizeDiffPath(candidate);
    if (normalized) {
      return normalized;
    }
  }

  for (const line of lines) {
    if (!line.startsWith("rename to ") && !line.startsWith("copy to ")) {
      continue;
    }
    const normalized = normalizePath(line.replace(/^(rename|copy) to\s+/, ""));
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function sanitizeModelVisibleReviewData(params: {
  diffPatch: string;
  changedFiles: Array<{
    path?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    patch?: string | null;
  }>;
}): {
  diffPatch: string;
  changedFiles: ModelVisibleChangedFile[];
  sensitivePaths: string[];
} {
  const { preamble, sections } = splitDiffSections(params.diffPatch);
  const redactedSectionPaths: string[] = [];
  const keptSections: string[][] = [];

  for (const section of sections) {
    const sectionPath = resolveDiffSectionPath(section);
    if (sectionPath && shouldSkipSensitivePath(sectionPath)) {
      redactedSectionPaths.push(sectionPath);
      continue;
    }
    keptSections.push(section);
  }

  const changedFiles = params.changedFiles.map((item) => {
    const normalizedPath = normalizeChangedPath(item.path);
    const sensitive = normalizedPath ? shouldSkipSensitivePath(normalizedPath) : false;
    return {
      ...item,
      patch: sensitive ? null : item.patch ?? null,
      sensitive,
      withheld_reason: sensitive ? "sensitive_file" : null
    };
  });

  const sensitivePaths = uniquePaths([
    ...redactedSectionPaths,
    ...changedFiles.filter((item) => item.sensitive).map((item) => item.path || "")
  ]);
  const diffLines = [...preamble, ...keptSections.flat()];
  const diffPatch = diffLines.join("\n").trim() ? diffLines.join("\n") : "";

  return {
    diffPatch,
    changedFiles,
    sensitivePaths
  };
}
