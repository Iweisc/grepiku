import fs from "fs/promises";
import path from "path";

export const DEFAULT_SANDBOX_TAR_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_SANDBOX_SYNC_MAX_BYTES = 10 * 1024 * 1024;

type FileKind = "file" | "directory" | "symlink";

export type LocalTreeEntry = {
  path: string;
  kind: FileKind;
  size: number;
};

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
}

function isAbsoluteArchivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized)
  );
}

export function validateTarEntryPath(name: string): string {
  const raw = name.trim();
  if (isAbsoluteArchivePath(raw)) {
    throw new Error(`sandbox tar entry path is absolute: ${name}`);
  }
  const normalized = normalizeRelativePath(raw);
  if (!normalized || normalized === ".") return ".";
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part.length === 0)) {
    throw new Error(`sandbox tar entry path escapes target: ${name}`);
  }
  return normalized;
}

export function validateSymlinkTarget(params: {
  entryPath: string;
  linkTarget: string;
}): void {
  const normalizedEntry = validateTarEntryPath(params.entryPath);
  if (isAbsoluteArchivePath(params.linkTarget)) {
    throw new Error(`sandbox tar symlink ${normalizedEntry} points outside target`);
  }
  const parent = normalizedEntry === "." ? "." : path.posix.dirname(normalizedEntry);
  const resolved = path.posix.normalize(path.posix.join(parent, params.linkTarget.replace(/\\/g, "/")));
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(`sandbox tar symlink ${normalizedEntry} points outside target`);
  }
}

function shouldSkipRelativePath(relativePath: string, options?: { excludeGit?: boolean }): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return Boolean(options?.excludeGit && (normalized === ".git" || normalized.startsWith(".git/")));
}

async function walkLocalTree(params: {
  root: string;
  current: string;
  entries: LocalTreeEntry[];
  maxBytes: number;
  total: { bytes: number };
  excludeGit?: boolean;
}): Promise<void> {
  const names = await fs.readdir(params.current);
  for (const name of names) {
    const absolute = path.join(params.current, name);
    const relativePath = normalizeRelativePath(path.relative(params.root, absolute));
    if (shouldSkipRelativePath(relativePath, { excludeGit: params.excludeGit })) {
      continue;
    }
    validateTarEntryPath(relativePath);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      const linkTarget = await fs.readlink(absolute);
      validateSymlinkTarget({ entryPath: relativePath, linkTarget });
      const lexicalTarget = path.resolve(path.dirname(absolute), linkTarget);
      if (!isWithinRoot(params.root, lexicalTarget)) {
        throw new Error(`sandbox transfer symlink ${relativePath} points outside source`);
      }
      const realTarget = await fs.realpath(absolute).catch((err: NodeJS.ErrnoException | Error) => {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw err;
      });
      if (realTarget && !isWithinRoot(params.root, realTarget)) {
        throw new Error(`sandbox transfer symlink ${relativePath} points outside source`);
      }
      params.entries.push({ path: relativePath, kind: "symlink", size: 0 });
      continue;
    }
    if (stat.isDirectory()) {
      params.entries.push({ path: relativePath, kind: "directory", size: 0 });
      await walkLocalTree({ ...params, current: absolute });
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    params.total.bytes += stat.size;
    if (params.total.bytes > params.maxBytes) {
      throw new Error(`sandbox transfer exceeded byte limit ${params.maxBytes}`);
    }
    params.entries.push({ path: relativePath, kind: "file", size: stat.size });
  }
}

export async function collectLocalTreeEntries(params: {
  root: string;
  maxBytes?: number;
  excludeGit?: boolean;
}): Promise<LocalTreeEntry[]> {
  const resolvedRoot = path.resolve(params.root);
  const entries: LocalTreeEntry[] = [];
  await walkLocalTree({
    root: resolvedRoot,
    current: resolvedRoot,
    entries,
    total: { bytes: 0 },
    maxBytes: params.maxBytes ?? DEFAULT_SANDBOX_TAR_MAX_BYTES,
    excludeGit: params.excludeGit
  });
  return entries;
}

async function ensureParent(pathName: string): Promise<void> {
  await fs.mkdir(path.dirname(pathName), { recursive: true });
}

async function copyEntry(params: {
  sourceRoot: string;
  targetRoot: string;
  relativePath: string;
  maxBytes: number;
  copied: { bytes: number };
}): Promise<void> {
  const source = path.resolve(params.sourceRoot, params.relativePath);
  const target = path.resolve(params.targetRoot, params.relativePath);
  if (!isWithinRoot(params.sourceRoot, source) || !isWithinRoot(params.targetRoot, target)) {
    throw new Error(`sandbox sync path escapes root: ${params.relativePath}`);
  }
  const stat = await fs.lstat(source);
  if (stat.isDirectory()) {
    const targetStat = await fs.lstat(target).catch(() => null);
    if (targetStat && !targetStat.isDirectory()) {
      await fs.rm(target, { recursive: true, force: true });
    }
    await fs.mkdir(target, { recursive: true });
    return;
  }
  await ensureParent(target);
  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(source);
    validateSymlinkTarget({ entryPath: params.relativePath, linkTarget });
    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(linkTarget, target);
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  params.copied.bytes += stat.size;
  if (params.copied.bytes > params.maxBytes) {
    throw new Error(`sandbox repo sync exceeded byte limit ${params.maxBytes}`);
  }
  await fs.rm(target, { recursive: true, force: true });
  await fs.copyFile(source, target);
}

export async function syncSandboxRepoBack(params: {
  sourceRoot: string;
  targetRoot: string;
  originalEntries: LocalTreeEntry[];
  maxBytes?: number;
}): Promise<void> {
  const sourceRoot = path.resolve(params.sourceRoot);
  const targetRoot = path.resolve(params.targetRoot);
  const sourceEntries = await collectLocalTreeEntries({
    root: sourceRoot,
    maxBytes: params.maxBytes ?? DEFAULT_SANDBOX_SYNC_MAX_BYTES,
    excludeGit: true
  });
  const sourcePaths = new Set(sourceEntries.map((entry) => entry.path));
  const copied = { bytes: 0 };

  for (const entry of sourceEntries) {
    if (entry.path === "." || shouldSkipRelativePath(entry.path, { excludeGit: true })) {
      continue;
    }
    await copyEntry({
      sourceRoot,
      targetRoot,
      relativePath: entry.path,
      maxBytes: params.maxBytes ?? DEFAULT_SANDBOX_SYNC_MAX_BYTES,
      copied
    });
  }

  const originalPaths = params.originalEntries
    .map((entry) => entry.path)
    .filter((entryPath) => entryPath !== "." && !shouldSkipRelativePath(entryPath, { excludeGit: true }))
    .sort((a, b) => b.length - a.length);
  for (const entryPath of originalPaths) {
    if (sourcePaths.has(entryPath)) continue;
    const target = path.resolve(targetRoot, entryPath);
    if (isWithinRoot(targetRoot, target)) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
}

export const __sandboxTransferInternals = {
  isWithinRoot,
  isAbsoluteArchivePath,
  normalizeRelativePath,
  shouldSkipRelativePath
};
