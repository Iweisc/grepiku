import { execa } from "execa";

export type LocalChangedFile = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string | null;
};

export async function buildLocalDiffPatch(params: {
  repoPath: string;
  baseSha: string | null | undefined;
  headSha: string;
}): Promise<string> {
  const { repoPath, baseSha, headSha } = params;
  if (!baseSha) return "";
  const { stdout } = await execa(
    "git",
    ["-C", repoPath, "diff", "--no-color", "--no-ext-diff", `${baseSha}...${headSha}`],
    { maxBuffer: 1024 * 1024 * 200 }
  );
  return stdout;
}

export async function buildLocalChangedFiles(params: {
  repoPath: string;
  baseSha: string | null | undefined;
  headSha: string;
}): Promise<LocalChangedFile[]> {
  const { repoPath, baseSha, headSha } = params;
  if (!baseSha) return [];

  const [nameStatusOut, numStatOut] = await Promise.all([
    execa("git", ["-C", repoPath, "diff", "--name-status", `${baseSha}...${headSha}`], {
      maxBuffer: 1024 * 1024 * 200
    }),
    execa("git", ["-C", repoPath, "diff", "--numstat", `${baseSha}...${headSha}`], {
      maxBuffer: 1024 * 1024 * 200
    })
  ]);

  return mergeLocalChangedFiles(nameStatusOut.stdout, numStatOut.stdout);
}

export function mergeLocalChangedFiles(nameStatus: string, numStat: string): LocalChangedFile[] {
  const byPath = new Map<string, LocalChangedFile>();

  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    const rawStatus = parts[0] || "";
    const path = (parts[parts.length - 1] || "").trim();
    if (!path) continue;
    byPath.set(path, {
      path,
      status: normalizeGitStatus(rawStatus),
      patch: null
    });
  }

  for (const line of numStat.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const additionsRaw = parts[0] || "";
    const deletionsRaw = parts[1] || "";
    const path = (parts[parts.length - 1] || "").trim();
    if (!path) continue;

    const additions = additionsRaw === "-" ? undefined : Number(additionsRaw);
    const deletions = deletionsRaw === "-" ? undefined : Number(deletionsRaw);
    const existing = byPath.get(path) || { path, patch: null };
    byPath.set(path, {
      ...existing,
      additions: Number.isFinite(additions) ? additions : undefined,
      deletions: Number.isFinite(deletions) ? deletions : undefined
    });
  }

  return Array.from(byPath.values());
}

function normalizeGitStatus(value: string): string {
  const code = value.trim().toUpperCase();
  if (code.startsWith("A")) return "added";
  if (code.startsWith("M")) return "modified";
  if (code.startsWith("D")) return "removed";
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("C")) return "copied";
  if (code.startsWith("T")) return "changed";
  if (code.startsWith("U")) return "modified";
  return code || "modified";
}
