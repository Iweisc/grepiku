import os from "os";
import path from "path";
import { execa, type Options } from "execa";

const GITHUB_GIT_EXTRAHEADER_KEY = "http.https://github.com/.extraheader";
const GIT_LFS_PROCESS_KEY = "filter.lfs.process";
const GIT_LFS_SMUDGE_KEY = "filter.lfs.smudge";
const GIT_LFS_REQUIRED_KEY = "filter.lfs.required";
const REDACTED_GIT_AUTH_VALUE = "[REDACTED]";
const SAFE_GIT_CONFIG_ENTRIES: Array<[key: string, value: string]> = [
  [GIT_LFS_PROCESS_KEY, ""],
  [GIT_LFS_SMUDGE_KEY, ""],
  [GIT_LFS_REQUIRED_KEY, "false"]
];

function gitCheckoutHomeDir(sourceEnv: NodeJS.ProcessEnv): string {
  const projectRoot = sourceEnv.PROJECT_ROOT?.trim();
  return projectRoot
    ? path.join(projectRoot, "var", "git-checkout-home")
    : path.join(os.tmpdir(), "grepiku-git-checkout-home");
}

function appendGitConfigEntries(
  sourceEnv: NodeJS.ProcessEnv,
  entries: Array<[key: string, value: string]>
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { ...sourceEnv };
  const currentCountRaw = Number(sourceEnv.GIT_CONFIG_COUNT || 0);
  let currentCount =
    Number.isInteger(currentCountRaw) && currentCountRaw >= 0 ? currentCountRaw : 0;
  for (const [key, value] of entries) {
    output[`GIT_CONFIG_KEY_${currentCount}`] = key;
    output[`GIT_CONFIG_VALUE_${currentCount}`] = value;
    currentCount += 1;
  }
  output.GIT_CONFIG_COUNT = String(currentCount);
  return output;
}

function stripInheritedGitEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value == null || key.startsWith("GIT_")) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function safeGitConfigEntriesFromEnv(sourceEnv: NodeJS.ProcessEnv): Array<[key: string, value: string]> {
  const currentCountRaw = Number(sourceEnv.GIT_CONFIG_COUNT || 0);
  const currentCount =
    Number.isInteger(currentCountRaw) && currentCountRaw > 0 ? currentCountRaw : 0;
  const allowed = new Map<string, string>(SAFE_GIT_CONFIG_ENTRIES);
  const entries: Array<[key: string, value: string]> = [];

  for (let index = 0; index < currentCount; index += 1) {
    const key = sourceEnv[`GIT_CONFIG_KEY_${index}`];
    const value = sourceEnv[`GIT_CONFIG_VALUE_${index}`];
    if (typeof key !== "string" || typeof value !== "string") {
      continue;
    }
    if (allowed.get(key) !== value) {
      continue;
    }
    entries.push([key, value]);
  }

  return entries;
}

function preserveSafeGitEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let output = stripInheritedGitEnv(sourceEnv);
  output = appendGitConfigEntries(output, safeGitConfigEntriesFromEnv(sourceEnv));
  if (sourceEnv.GIT_LFS_SKIP_SMUDGE === "1") {
    output.GIT_LFS_SKIP_SMUDGE = "1";
  }
  if (sourceEnv.GIT_CONFIG_NOSYSTEM === "1") {
    output.GIT_CONFIG_NOSYSTEM = "1";
  }
  if (sourceEnv.GIT_CONFIG_GLOBAL === os.devNull) {
    output.GIT_CONFIG_GLOBAL = os.devNull;
  }
  return output;
}

function githubHttpExtraHeaderValue(token: string): string {
  const basicAuth = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return `AUTHORIZATION: basic ${basicAuth}`;
}

export function githubRemoteUrl(params: { owner: string; repo: string }): string {
  return `https://github.com/${params.owner}/${params.repo}.git`;
}

export function githubHttpExtraHeaderConfig(token: string): string {
  return `${GITHUB_GIT_EXTRAHEADER_KEY}=${githubHttpExtraHeaderValue(token)}`;
}

export function gitCheckoutSafetyEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const checkoutHomeDir = gitCheckoutHomeDir(sourceEnv);
  const output = appendGitConfigEntries(stripInheritedGitEnv(sourceEnv), [...SAFE_GIT_CONFIG_ENTRIES]);
  output.GIT_LFS_SKIP_SMUDGE = "1";
  output.GIT_CONFIG_NOSYSTEM = "1";
  output.GIT_CONFIG_GLOBAL = os.devNull;
  output.HOME = checkoutHomeDir;
  output.XDG_CONFIG_HOME = path.join(checkoutHomeDir, ".config");
  output.XDG_CACHE_HOME = path.join(checkoutHomeDir, ".cache");
  output.XDG_STATE_HOME = path.join(checkoutHomeDir, ".state");
  return output;
}

export function githubGitAuthEnv(
  token: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const output = appendGitConfigEntries(preserveSafeGitEnv(sourceEnv), [
    [GITHUB_GIT_EXTRAHEADER_KEY, githubHttpExtraHeaderValue(token)]
  ]);
  output.GIT_TERMINAL_PROMPT = "0";
  return output;
}

function redactGithubGitAuthText(value: string): string {
  return value
    .replace(
      /http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=]+/gi,
      `${GITHUB_GIT_EXTRAHEADER_KEY}=${REDACTED_GIT_AUTH_VALUE}`
    )
    .replace(
      /AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=]+/gi,
      `AUTHORIZATION: ${REDACTED_GIT_AUTH_VALUE}`
    )
    .replace(
      /x-access-token:[^@\s]+@github\.com/gi,
      `x-access-token:${REDACTED_GIT_AUTH_VALUE}@github.com`
    );
}

function sanitizeGithubGitAuthValue(
  value: unknown,
  seen: WeakMap<object, unknown>
): unknown {
  if (typeof value === "string") {
    return redactGithubGitAuthText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const existing = seen.get(value);
  if (existing) {
    return existing;
  }
  if (value instanceof Error) {
    const clone = new Error(redactGithubGitAuthText(value.message));
    clone.name = value.name;
    if (value.stack) {
      clone.stack = redactGithubGitAuthText(value.stack);
    }
    seen.set(value, clone);
    for (const [key, entry] of Object.entries(value as unknown as Record<string, unknown>)) {
      (clone as unknown as Record<string, unknown>)[key] = sanitizeGithubGitAuthValue(entry, seen);
    }
    return clone;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const entry of value) {
      clone.push(sanitizeGithubGitAuthValue(entry, seen));
    }
    return clone;
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = sanitizeGithubGitAuthValue(entry, seen);
  }
  return clone;
}

export function sanitizeGithubGitAuthError(error: unknown): unknown {
  return sanitizeGithubGitAuthValue(error, new WeakMap());
}

export async function execaAuthenticatedGit(
  token: string,
  args: string[],
  options?: Options
) {
  try {
    return await execa("git", args, {
      ...options,
      env: githubGitAuthEnv(token, options?.env ?? process.env)
    });
  } catch (error) {
    throw sanitizeGithubGitAuthError(error);
  }
}
