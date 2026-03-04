import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import { execa } from "execa";
import { buildLocalDiffPatch, buildLocalChangedFiles } from "../review/localCompare.js";
import { refineReviewComments } from "../review/quality.js";
import { buildDiffIndex } from "../review/diff.js";
import { loadRepoConfig } from "../review/config.js";
import { buildReviewerPrompt, buildEditorPrompt } from "../review/prompts.js";
import { createRunDirs, writeBundleFiles } from "../review/bundle.js";
import { ReviewSchema } from "../review/schemas.js";
import { readAndValidateJson } from "../review/json.js";
import type { ReviewComment, ReviewOutput } from "../review/schemas.js";
import type { ContextPack } from "../review/context.js";

const ArgsSchema = z.object({
  repoPath: z.string(),
  base: z.string().optional(),
  head: z.string().optional(),
  diffFile: z.string().optional(),
  output: z.string().optional(),
  format: z.enum(["json", "text"]).default("json")
});

type DemoArgs = z.infer<typeof ArgsSchema>;

const FLAG_MAP: Record<string, string> = {
  "--repo-path": "repoPath",
  "--base": "base",
  "--head": "head",
  "--diff-file": "diffFile",
  "--output": "output",
  "--format": "format"
};

export function parseCliArgs(argv: string[]): DemoArgs {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Handle --flag=value
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx);
      const field = FLAG_MAP[key];
      if (field) {
        raw[field] = arg.slice(eqIdx + 1);
        continue;
      }
    }
    // Handle --flag value
    const field = FLAG_MAP[arg];
    if (field && i + 1 < argv.length) {
      raw[field] = argv[++i];
    }
  }
  return ArgsSchema.parse(raw);
}

async function resolveGitSha(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await execa("git", ["-C", repoPath, "rev-parse", ref]);
  return stdout.trim();
}

async function resolveHeadSha(repoPath: string, head?: string): Promise<string> {
  if (head) return resolveGitSha(repoPath, head);
  return resolveGitSha(repoPath, "HEAD");
}

async function resolveBaseSha(repoPath: string, base?: string): Promise<string> {
  if (base) return resolveGitSha(repoPath, base);
  const { stdout } = await execa("git", ["-C", repoPath, "merge-base", "HEAD", "HEAD~1"]);
  return stdout.trim();
}

export function buildEmptyContextPack(diffPatch: string, changedFiles: Array<{ path: string }>): ContextPack {
  return {
    query: "",
    retrieved: [],
    relatedFiles: [],
    changedFileStats: changedFiles.map((file) => ({
      path: file.path,
      status: undefined,
      additions: undefined,
      deletions: undefined,
      risk: "low" as const
    })),
    graphLinks: [],
    graphPaths: [],
    graphDebug: {
      seedNodes: 0,
      touchedSymbolSeeds: 0,
      visitedNodes: 0,
      traversedEdges: 0,
      prunedByBudget: 0,
      maxDepth: 0,
      minScore: 0,
      maxNodesVisited: 0,
      traversalMs: 0
    },
    hotspots: [],
    reviewFocus: []
  };
}

export function formatTextOutput(review: ReviewOutput, comments: ReviewComment[]): string {
  const lines: string[] = [];
  lines.push("=== Demo Review ===");
  lines.push("");
  lines.push(`Risk: ${review.summary.risk}`);
  lines.push(`Overview: ${review.summary.overview}`);
  lines.push("");
  if (review.summary.key_concerns.length > 0) {
    lines.push("Key Concerns:");
    for (const concern of review.summary.key_concerns) {
      lines.push(`  - ${concern}`);
    }
    lines.push("");
  }
  if (comments.length === 0) {
    lines.push("No findings.");
  } else {
    lines.push(`Findings (${comments.length}):`);
    lines.push("");
    for (const comment of comments) {
      const type = comment.comment_type || "inline";
      lines.push(`[${comment.severity.toUpperCase()}] ${comment.title}`);
      lines.push(`  Path: ${comment.path}:${comment.line} (${comment.side})`);
      lines.push(`  Category: ${comment.category} | Type: ${type}`);
      if (comment.confidence) {
        lines.push(`  Confidence: ${comment.confidence}`);
      }
      lines.push(`  ${comment.body}`);
      if (comment.suggested_patch) {
        lines.push(`  Suggested patch:`);
        for (const patchLine of comment.suggested_patch.split("\n")) {
          lines.push(`    ${patchLine}`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const repoPath = path.resolve(args.repoPath);

  // Dynamic import to avoid triggering loadEnv() at module load time.
  // This allows the pure utility functions (parseCliArgs, buildEmptyContextPack,
  // formatTextOutput) to be imported and tested without env variables set.
  const { runCodexStage } = await import("../runner/codexRunner.js");

  console.log(`[demo-review] repo=${repoPath}`);

  const headSha = await resolveHeadSha(repoPath, args.head);
  const baseSha = await resolveBaseSha(repoPath, args.base);
  console.log(`[demo-review] base=${baseSha.slice(0, 12)} head=${headSha.slice(0, 12)}`);

  let diffPatch: string;
  if (args.diffFile) {
    diffPatch = await fs.readFile(path.resolve(args.diffFile), "utf8");
    console.log(`[demo-review] diff loaded from file: ${args.diffFile}`);
  } else {
    diffPatch = await buildLocalDiffPatch({ repoPath, baseSha, headSha });
    console.log(`[demo-review] diff built from local repo`);
  }

  const changedFiles = await buildLocalChangedFiles({ repoPath, baseSha, headSha });
  console.log(`[demo-review] ${changedFiles.length} changed files`);

  if (changedFiles.length === 0 && diffPatch.trim().length === 0) {
    const empty = { summary: { overview: "No changes detected.", risk: "low", key_concerns: [], what_to_test: [] }, comments: [] };
    const output = args.format === "text" ? "No changes detected." : JSON.stringify(empty, null, 2);
    if (args.output) {
      await fs.writeFile(path.resolve(args.output), output, "utf8");
      console.log(`[demo-review] output written to ${args.output}`);
    } else {
      console.log(output);
    }
    return;
  }

  const { config, warnings } = await loadRepoConfig(repoPath);
  if (warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`[demo-review] config warning: ${warning}`);
    }
  }

  const contextPack = buildEmptyContextPack(diffPatch, changedFiles);
  const demoRunId = Date.now();
  const runRoot = path.join(repoPath, ".grepiku-demo");
  const { bundleDir, outDir, codexHomeDir } = await createRunDirs(runRoot, demoRunId);

  const prMarkdown = `# Demo Review\n\nLocal review of ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}\n`;
  await writeBundleFiles({
    bundleDir,
    prMarkdown,
    diffPatch,
    changedFiles,
    repoConfig: config,
    resolvedConfig: config,
    contextPack,
    warnings
  });

  const promptPaths = { repoPath, bundleDir, outDir };

  console.log("[demo-review] running reviewer stage...");
  const reviewerPrompt = buildReviewerPrompt(config, promptPaths);
  await runCodexStage({
    stage: "reviewer",
    repoPath,
    bundleDir,
    outDir,
    codexHomeDir,
    prompt: reviewerPrompt,
    headSha,
    repoId: 0,
    reviewRunId: demoRunId,
    prNumber: 0
  });

  const draft = await readAndValidateJson(
    path.join(outDir, "draft_review.json"),
    ReviewSchema
  );

  console.log("[demo-review] running editor stage...");
  const editorPrompt = buildEditorPrompt(JSON.stringify(draft, null, 2), promptPaths);
  await runCodexStage({
    stage: "editor",
    repoPath,
    bundleDir,
    outDir,
    codexHomeDir,
    prompt: editorPrompt,
    headSha,
    repoId: 0,
    reviewRunId: demoRunId,
    prNumber: 0
  });

  const finalReview = await readAndValidateJson(
    path.join(outDir, "final_review.json"),
    ReviewSchema
  );

  const diffIndex = buildDiffIndex(diffPatch);
  const { comments, diagnostics } = refineReviewComments({
    comments: finalReview.comments,
    diffIndex,
    changedFiles,
    maxInlineComments: config.limits.max_inline_comments,
    summaryOnly: config.output.summaryOnly,
    allowedTypes: config.commentTypes.allow
  });

  console.log(
    `[demo-review] quality gate: ${comments.length} comments kept ` +
      `(dropped=${diagnostics.droppedEmpty} dedup=${diagnostics.deduplicated} ` +
      `toSummary=${diagnostics.convertedToSummary} downgradedBlocking=${diagnostics.downgradedBlocking} ` +
      `perFileCap=${diagnostics.droppedPerFileCap})`
  );

  const result = {
    summary: finalReview.summary,
    comments,
    diagnostics
  };

  let output: string;
  if (args.format === "text") {
    output = formatTextOutput(finalReview, comments);
  } else {
    output = JSON.stringify(result, null, 2);
  }

  if (args.output) {
    await fs.writeFile(path.resolve(args.output), output, "utf8");
    console.log(`[demo-review] output written to ${args.output}`);
  } else {
    console.log(output);
  }

  console.log("[demo-review] done");
}

export const __demoReviewInternals = {
  parseCliArgs,
  buildEmptyContextPack,
  formatTextOutput
};

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  main()
    .catch((error) => {
      console.error("[demo-review] failed", error);
      process.exitCode = 1;
    });
}
