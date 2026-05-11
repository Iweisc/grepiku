import crypto from "crypto";
import { execa } from "execa";
import { gitCheckoutSafetyEnv } from "../github/gitAuth.js";

export type PatternRepositoryConfig = {
  name: string;
  url: string;
  ref?: string;
  scope?: string;
};

const GITHUB_HOSTNAME = "github.com";
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const patternRepositoryChains = new Map<string, Promise<void>>();

function normalizePatternRepositoryRef(value: string | undefined): string {
  const trimmed = value?.trim() || "";
  return trimmed || "HEAD";
}

export function resolvePatternRepositoryCheckoutTarget(value: string | undefined): string {
  const trimmed = value?.trim() || "";
  return trimmed || "origin/HEAD";
}

export async function withPatternRepositoryLock<T>(
  scopeKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const normalizedScopeKey = scopeKey.trim();
  if (!normalizedScopeKey) {
    return fn();
  }

  const previous = patternRepositoryChains.get(normalizedScopeKey) || Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduled = previous.catch(() => undefined).then(() => gate);
  patternRepositoryChains.set(normalizedScopeKey, scheduled);

  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (patternRepositoryChains.get(normalizedScopeKey) === scheduled) {
      patternRepositoryChains.delete(normalizedScopeKey);
    }
  }
}

export async function resolvePatternRepositoryCheckoutCommit(params: {
  repoPath: string;
  ref?: string;
}): Promise<string> {
  const target = resolvePatternRepositoryCheckoutTarget(params.ref);
  try {
    const { stdout } = await execa(
      "git",
      [
        "-C",
        params.repoPath,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${target}^{commit}`
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env: gitCheckoutSafetyEnv()
      }
    );
    const resolved = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(resolved)) {
      throw new Error("unexpected git rev-parse output");
    }
    return resolved;
  } catch {
    throw new Error("Unable to resolve pattern repository ref to a commit");
  }
}

function isSafeRepoPathSegment(value: string): boolean {
  return Boolean(value) && value !== "." && value !== ".." && SAFE_PATH_SEGMENT.test(value);
}

export function normalizePatternRepositoryUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
  if (parsed.hostname.toLowerCase() !== GITHUB_HOSTNAME) return null;

  const pathname = parsed.pathname.replace(/\/+$/, "");
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;

  const owner = decodeURIComponent(segments[0] || "");
  const repoSegment = decodeURIComponent(segments[1] || "");
  const hasGitSuffix = repoSegment.toLowerCase().endsWith(".git");
  const repoName = hasGitSuffix ? repoSegment.slice(0, -4) : repoSegment;

  if (!isSafeRepoPathSegment(owner) || !isSafeRepoPathSegment(repoName)) {
    return null;
  }

  const suffix = hasGitSuffix ? ".git" : "";
  return `https://${GITHUB_HOSTNAME}/${owner}/${repoName}${suffix}`;
}

export function sanitizePatternRepositories<T extends PatternRepositoryConfig>(
  items: T[] | null | undefined,
  options?: { warnings?: string[]; warningPrefix?: string }
): T[] {
  const warnings = options?.warnings;
  const warningPrefix = options?.warningPrefix || "config";
  const sanitized: T[] = [];
  const seen = new Set<string>();

  for (const [index, item] of (items || []).entries()) {
    const normalizedUrl = normalizePatternRepositoryUrl(item.url);
    if (!normalizedUrl) {
      warnings?.push(
        `${warningPrefix}:patternRepositories[${index}].url: only https://github.com/<owner>/<repo>(.git) is allowed`
      );
      continue;
    }

    const dedupeKey = [normalizedUrl, item.ref || "", item.scope || ""].join("\0");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    sanitized.push({
      ...item,
      url: normalizedUrl
    });
  }

  return sanitized;
}

export function patternRepositoryDirName(
  repo: Pick<PatternRepositoryConfig, "name" | "url" | "ref">
): string {
  const baseName = repo.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "pattern-repo";
  const normalizedUrl = normalizePatternRepositoryUrl(repo.url) || repo.url.trim();
  const digest = crypto
    .createHash("sha256")
    .update(`${normalizedUrl}\0${normalizePatternRepositoryRef(repo.ref)}`)
    .digest("hex")
    .slice(0, 12);
  return `${baseName}-${digest}`;
}

export function patternRepositoryGitConfigArgs(): string[] {
  return [
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.http.allow=never",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.ssh.allow=never",
    "-c",
    "protocol.git.allow=never"
  ];
}
