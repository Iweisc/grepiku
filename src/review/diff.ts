import parseDiff from "parse-diff";
import crypto from "crypto";
import { ReviewComment } from "./schemas.js";

export type HunkInfo = {
  hash: string;
  rightLines: Set<number>;
  leftLines: Set<number>;
  rightChanges: Array<{ line: number; content: string; type: string }>;
  leftChanges: Array<{ line: number; content: string; type: string }>;
};

export type DiffIndex = {
  files: Map<string, { hunks: HunkInfo[]; right: Set<number>; left: Set<number> }>;
};

export function parsePatch(patch: string) {
  return parseDiff(patch);
}

function hashText(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function buildDiffIndex(patch: string): DiffIndex {
  const files = new Map<string, { hunks: HunkInfo[]; right: Set<number>; left: Set<number> }>();
  const parsed = parsePatch(patch);

  for (const file of parsed) {
    const right = new Set<number>();
    const left = new Set<number>();
    const hunks: HunkInfo[] = [];
    for (const chunk of file.chunks || []) {
      const rightLines = new Set<number>();
      const leftLines = new Set<number>();
      const rightChanges: Array<{ line: number; content: string; type: string }> = [];
      const leftChanges: Array<{ line: number; content: string; type: string }> = [];

      const signature = (chunk.changes || [])
        .map((change) => `${change.type}:${change.content}`)
        .join("\n");
      const hunkHash = hashText(signature);

      for (const change of chunk.changes || []) {
        const anyChange = change as unknown as {
          ln?: number;
          ln1?: number;
          ln2?: number;
          content: string;
          type: string;
        };

        if (anyChange.type === "add") {
          if (typeof anyChange.ln === "number") {
            rightLines.add(anyChange.ln);
            right.add(anyChange.ln);
            rightChanges.push({ line: anyChange.ln, content: anyChange.content, type: anyChange.type });
          }
          continue;
        }

        if (anyChange.type === "del") {
          if (typeof anyChange.ln === "number") {
            leftLines.add(anyChange.ln);
            left.add(anyChange.ln);
            leftChanges.push({ line: anyChange.ln, content: anyChange.content, type: anyChange.type });
          }
          continue;
        }

        // normal lines include both sides
        if (typeof anyChange.ln2 === "number") {
          rightLines.add(anyChange.ln2);
          right.add(anyChange.ln2);
          rightChanges.push({ line: anyChange.ln2, content: anyChange.content, type: anyChange.type });
        }
        if (typeof anyChange.ln1 === "number") {
          leftLines.add(anyChange.ln1);
          left.add(anyChange.ln1);
          leftChanges.push({ line: anyChange.ln1, content: anyChange.content, type: anyChange.type });
        }
      }

      hunks.push({
        hash: hunkHash,
        rightLines,
        leftLines,
        rightChanges,
        leftChanges
      });
    }

    const path = normalizePath(file.to || file.from || "");
    files.set(path, { hunks, right, left });
  }

  return { files };
}

export function isLineInDiff(index: DiffIndex, comment: ReviewComment): boolean {
  const file = index.files.get(normalizePath(comment.path));
  if (!file) return false;
  const set = comment.side === "RIGHT" ? file.right : file.left;
  return set.has(comment.line);
}

export function hunkHashForComment(index: DiffIndex, comment: ReviewComment): string {
  const file = index.files.get(normalizePath(comment.path));
  if (!file) return "";
  const hunks = file.hunks;
  for (const hunk of hunks) {
    const set = comment.side === "RIGHT" ? hunk.rightLines : hunk.leftLines;
    if (set.has(comment.line)) {
      return hunk.hash;
    }
  }
  return "";
}

export function contextHashForComment(index: DiffIndex, comment: ReviewComment): string {
  const file = index.files.get(normalizePath(comment.path));
  if (!file) return "";
  const hunks = file.hunks;
  for (const hunk of hunks) {
    const set = comment.side === "RIGHT" ? hunk.rightLines : hunk.leftLines;
    if (!set.has(comment.line)) continue;
    const changes = comment.side === "RIGHT" ? hunk.rightChanges : hunk.leftChanges;
    const sorted = [...changes].sort((a, b) => a.line - b.line);
    const idx = sorted.findIndex((c) => c.line === comment.line);
    if (idx === -1) break;
    const start = Math.max(0, idx - 3);
    const end = Math.min(sorted.length, idx + 4);
    const contextSig = sorted
      .slice(start, end)
      .map((c) => `${c.type}:${c.content}`)
      .join("\n");
    return hashText(contextSig);
  }
  return "";
}

export function normalizePath(path: string): string {
  let normalized = path.replace(/^\//, "");
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}
