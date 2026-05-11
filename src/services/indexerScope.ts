import crypto from "crypto";
import { normalizePatternRepositoryUrl } from "../review/patternRepositories.js";

export type IndexedPatternRepo = {
  url: string;
  ref?: string;
  name?: string;
};

const PATTERN_PATH_PREFIX = ".grepiku/patterns";

function normalizePatternRepositoryRef(value: string | undefined): string {
  const trimmed = value?.trim() || "";
  return trimmed || "HEAD";
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function patternRepoScopeKey(patternRepo?: IndexedPatternRepo | null): string | null {
  const rawUrl = patternRepo?.url?.trim() || "";
  if (!rawUrl) return null;
  const normalizedUrl = normalizePatternRepositoryUrl(rawUrl) || rawUrl;
  return crypto
    .createHash("sha256")
    .update(`${normalizedUrl}\0${normalizePatternRepositoryRef(patternRepo?.ref)}`)
    .digest("hex")
    .slice(0, 12);
}

export function buildPatternIndexedPathPrefix(
  patternRepo?: IndexedPatternRepo | null
): string | null {
  const scopeKey = patternRepoScopeKey(patternRepo);
  if (!scopeKey) return null;
  return `${PATTERN_PATH_PREFIX}/${scopeKey}/`;
}

export function buildIndexedFilePath(
  relativePath: string,
  patternRepo?: IndexedPatternRepo | null
): string {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const prefix = buildPatternIndexedPathPrefix(patternRepo);
  if (!prefix) return normalizedRelativePath;
  return `${prefix}${normalizedRelativePath}`;
}

export function buildPruneIndexedFilesWhere(params: {
  repoId: number;
  isPattern: boolean;
  keepFileIds: number[];
  patternRepo?: IndexedPatternRepo | null;
}): Record<string, unknown> {
  const where: Record<string, unknown> = {
    repoId: params.repoId,
    isPattern: params.isPattern
  };
  if (params.keepFileIds.length > 0) {
    where.id = { notIn: params.keepFileIds };
  }
  if (params.isPattern) {
    const prefix = buildPatternIndexedPathPrefix(params.patternRepo);
    if (prefix) {
      where.path = { startsWith: prefix };
    }
  }
  return where;
}
