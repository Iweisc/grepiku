import { shouldSkipSensitivePath } from "../services/indexerPathPolicy.js";
import { normalizeDiffPath, normalizePath } from "./diff.js";

export type ModelVisibleChangedFile = {
  filename?: string;
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

function pathForChangedFile(item: { filename?: string; path?: string }): string {
  return normalizeChangedPath(item.path || item.filename);
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

function resolveDiffSectionPaths(lines: string[]): string[] {
  const paths: string[] = [];
  const addPath = (value: string) => {
    const normalized = normalizeDiffPath(value);
    if (normalized && !paths.includes(normalized)) {
      paths.push(normalized);
    }
  };

  for (const line of lines) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) {
      continue;
    }
    const candidate = line.slice(4).trim();
    if (!candidate || candidate === "/dev/null") {
      continue;
    }
    addPath(candidate);
  }

  for (const line of lines) {
    if (
      !line.startsWith("rename from ") &&
      !line.startsWith("rename to ") &&
      !line.startsWith("copy from ") &&
      !line.startsWith("copy to ")
    ) {
      continue;
    }
    addPath(line.replace(/^(rename|copy) (from|to)\s+/, ""));
  }

  return paths;
}

function countSectionChanges(lines: string[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function basename(value: string): string {
  const normalized = normalizePath(value);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

const BULK_NOISE_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "pdm.lock",
  "pipfile.lock",
  "go.sum",
  "flake.lock",
  "gradle.lockfile",
  "backup.sql",
  "dump.sql"
]);

const BULK_NOISE_PATH_PATTERNS = [
  /(^|\/)(coverage|dist|build|out|\.next|\.turbo|\.cache|playwright-report|test-results)\//,
  /(^|\/)(tmp|\.tmp)\//,
  /(^|\/)\.playwright-mcp\//,
  /(^|\/)(__generated__|generated)\//,
  /(^|\/)[^/]+\.(generated|gen)\.[^/]+$/,
  /(^|\/)[^/]+\.bak$/,
  /(^|\/)[^/]+\.pb\.(go|ts|js)$/,
  /(^|\/)[^/]+\.min\.(js|css)$/
];

function isLargeGeneratedDataPath(pathValue: string, changedLines: number): boolean {
  if (changedLines < 1_000) return false;
  const lower = pathValue.toLowerCase();
  if (!/\.(json|ts|tsx|js|jsx|mjs|cjs|html|log|md)$/.test(lower)) return false;
  return lower.includes("/src/data/") || lower.includes("/fixtures/") || lower.includes("/fixture/");
}

function isLargeReviewLowSignalPath(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  if (
    /(^|\/)(__tests__|tests?|specs?|fixtures?|mocks?|__snapshots__|snapshots|testdata)(\/|$)/.test(lower) ||
    /(^|\/)[^/]+(_test|\.(test|spec))\.(go|ts|tsx|js|jsx|py|rb|java|kt|rs)$/.test(lower)
  ) {
    return true;
  }
  if (/(^|\/)(docs?|changelogs?)(\/|$)/.test(lower) && /\.(md|mdx|rst|txt)$/.test(lower)) {
    return true;
  }
  return /\.(snap|png|jpe?g|gif|webp|svg|ico|pdf|mp4|mov|woff2?|ttf|eot)$/.test(lower);
}

export function shouldOmitBulkNoisePath(params: {
  path: string;
  additions?: number;
  deletions?: number;
  largeReview?: boolean;
}): boolean {
  const normalized = normalizePath(params.path).toLowerCase();
  if (!normalized) return false;
  if (BULK_NOISE_BASENAMES.has(basename(normalized))) return true;
  if (BULK_NOISE_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  const changedLines = Math.max(0, params.additions || 0) + Math.max(0, params.deletions || 0);
  if (params.largeReview && isLargeReviewLowSignalPath(normalized)) return true;
  return isLargeGeneratedDataPath(normalized, changedLines);
}

export function sanitizeModelVisibleReviewData(params: {
  diffPatch: string;
  changedFiles: Array<{
    filename?: string;
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
  bulkNoisePaths: string[];
} {
  const { preamble, sections } = splitDiffSections(params.diffPatch);
  const totalChangedLines = params.changedFiles.reduce(
    (sum, item) => sum + Math.max(0, item.additions || 0) + Math.max(0, item.deletions || 0),
    0
  );
  const largeReview = totalChangedLines >= 50_000;
  const redactedSectionPaths: string[] = [];
  const omittedBulkNoisePaths: string[] = [];
  const keptSections: string[][] = [];
  const changedFileByPath = new Map(
    params.changedFiles
      .map((item) => [pathForChangedFile(item), item] as const)
      .filter(([path]) => Boolean(path))
  );

  for (const section of sections) {
    const sectionPaths = resolveDiffSectionPaths(section);
    const sensitiveSectionPaths = sectionPaths.filter((sectionPath) =>
      shouldSkipSensitivePath(sectionPath)
    );
    if (sensitiveSectionPaths.length > 0) {
      redactedSectionPaths.push(...sensitiveSectionPaths);
      continue;
    }
    const sectionPath = sectionPaths[0] ?? null;
    if (sectionPath) {
      const metadata = changedFileByPath.get(sectionPath);
      const sectionChanges = countSectionChanges(section);
      if (
        shouldOmitBulkNoisePath({
          path: sectionPath,
          additions: metadata?.additions ?? sectionChanges.additions,
          deletions: metadata?.deletions ?? sectionChanges.deletions,
          largeReview
        })
      ) {
        omittedBulkNoisePaths.push(sectionPath);
        continue;
      }
    }
    keptSections.push(section);
  }

  const changedFiles = params.changedFiles.flatMap((item) => {
    const normalizedPath = pathForChangedFile(item);
    const sensitive = normalizedPath ? shouldSkipSensitivePath(normalizedPath) : false;
    if (
      !sensitive &&
      normalizedPath &&
      shouldOmitBulkNoisePath({
        path: normalizedPath,
        additions: item.additions,
        deletions: item.deletions,
        largeReview
      })
    ) {
      omittedBulkNoisePaths.push(normalizedPath);
      return [];
    }
    return [{
      ...item,
      patch: sensitive ? null : item.patch ?? null,
      sensitive,
      withheld_reason: sensitive ? "sensitive_file" : null
    }];
  });

  const sensitivePaths = uniquePaths([
    ...redactedSectionPaths,
    ...changedFiles.filter((item) => item.sensitive).map((item) => item.path || item.filename || "")
  ]);
  const bulkNoisePaths = uniquePaths(omittedBulkNoisePaths);
  const diffLines = [...preamble, ...keptSections.flat()];
  const diffPatch = diffLines.join("\n").trim() ? diffLines.join("\n") : "";

  return {
    diffPatch,
    changedFiles,
    sensitivePaths,
    bulkNoisePaths
  };
}
