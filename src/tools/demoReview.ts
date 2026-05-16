import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { z } from "zod";
import { execa } from "execa";
import { gitCheckoutSafetyEnv } from "../github/gitAuth.js";
import { buildLocalDiffPatch, buildLocalChangedFiles } from "../review/localCompare.js";
import { refineReviewComments } from "../review/quality.js";
import { buildDiffIndex } from "../review/diff.js";
import { loadRepoConfigAtGitRef, type RepoConfig } from "../review/config.js";
import {
  buildDirectReviewerPrompt,
  buildReviewerPrompt,
  buildEditorPrompt
} from "../review/prompts.js";
import { createRunDirs, writeBundleFiles } from "../review/bundle.js";
import { renderPrMarkdown } from "../review/prMarkdown.js";
import { sanitizeModelVisibleReviewData } from "../review/sensitiveReviewData.js";
import { ReviewSchema } from "../review/schemas.js";
import { readAndValidateJsonWithFallback } from "../review/json.js";
import {
  buildReviewDiffChunkPlan,
  mergeChunkReviewDrafts,
  type ReviewChunkDraft,
  type ReviewDiffChunk,
  type ReviewDiffChunkPlan
} from "../review/diffChunks.js";
import {
  buildContextPackForChunk,
  chunkHasHighImpactHotspot,
  scopeContextPackToChunk
} from "../review/chunkContext.js";
import type { ReviewComment, ReviewOutput } from "../review/schemas.js";
import type { ContextPack } from "../review/context.js";
import {
  applyEditorDecisionOutput,
  buildCompactEditorInput,
  buildDeterministicEditorDecisionOutput
} from "../review/editorDecision.js";

const ArgsSchema = z.object({
  repoPath: z.string(),
  base: z.string().optional(),
  head: z.string().optional(),
  diffFile: z.string().optional(),
  output: z.string().optional(),
  format: z.enum(["json", "text"]).default("json"),
  repoId: z.coerce.number().int().positive().optional(),
  contextMode: z.enum(["production", "empty"]).default("production")
});

type DemoArgs = z.infer<typeof ArgsSchema>;

const MAX_DEMO_DIFF_FILE_BYTES = 25 * 1024 * 1024;
const CHUNKED_REVIEW_MIN_CHANGED_LINES = 16_000;
const CHUNKED_REVIEW_TARGET_CHANGED_LINES = 6_000;
const CHUNKED_REVIEW_MAX_CHANGED_LINES = 7_000;
const CHUNKED_REVIEW_HIGH_TARGET_CHANGED_LINES = 3_000;
const CHUNKED_REVIEW_HIGH_MAX_CHANGED_LINES = 3_800;
const CHUNKED_REVIEW_MAX_FILES = 240;
const CHUNKED_REVIEW_MAX_PARALLEL = 48;
const CHUNKED_EDITOR_MAX_CANDIDATE_COMMENTS = 48;
const PRODUCTION_CONTEXT_REPO_ID_ERROR =
  "Production demo context requires --repo-id. Use --context-mode=empty only for smoke tests without retrieval/graph context.";
type DemoRunCodexStage = typeof import("../runner/codexRunner.js").runCodexStage;
type DemoRunDirectModelStage = typeof import("../runner/directModelRunner.js").runDirectModelStage;
type DemoReasoningEffort = "low" | "medium" | "high" | "xhigh";

const FLAG_MAP: Record<string, string> = {
  "--repo-path": "repoPath",
  "--base": "base",
  "--head": "head",
  "--diff-file": "diffFile",
  "--output": "output",
  "--format": "format",
  "--repo-id": "repoId",
  "--context-mode": "contextMode"
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

async function resolveGitSha(
  repoPath: string,
  ref: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const normalizedRef = ref.trim();
  if (!normalizedRef) {
    throw new Error("Invalid git ref");
  }

  try {
    const { stdout } = await execa(
      "git",
      ["-C", repoPath, "rev-parse", "--verify", "--end-of-options", `${normalizedRef}^{commit}`],
      {
        env: gitCheckoutSafetyEnv(sourceEnv)
      }
    );
    const resolved = stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(resolved)) {
      throw new Error("unexpected git rev-parse output");
    }
    return resolved;
  } catch {
    throw new Error(`Invalid git ref: ${ref}`);
  }
}

async function resolveHeadSha(
  repoPath: string,
  head?: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (head) return resolveGitSha(repoPath, head, sourceEnv);
  return resolveGitSha(repoPath, "HEAD", sourceEnv);
}

async function resolveBaseSha(
  repoPath: string,
  base?: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (base) return resolveGitSha(repoPath, base, sourceEnv);
  const { stdout } = await execa("git", ["-C", repoPath, "merge-base", "HEAD", "HEAD~1"], {
    env: gitCheckoutSafetyEnv(sourceEnv)
  });
  return stdout.trim();
}

export function buildDemoRunRoot(repoPath: string): string {
  const resolvedRepoPath = path.resolve(repoPath);
  const digest = crypto
    .createHash("sha256")
    .update(resolvedRepoPath)
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), "grepiku-demo", digest);
}

function demoDiffFileLimitError(filePath: string, maxBytes: number): Error {
  return new Error(`diff file exceeded byte limit (${maxBytes} bytes): ${filePath}`);
}

export async function readDiffFileWithinLimit(
  filePath: string,
  maxBytes = MAX_DEMO_DIFF_FILE_BYTES
): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) {
      throw demoDiffFileLimitError(filePath, maxBytes);
    }
    const buffer = Buffer.alloc(Math.max(0, Number(stat.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function serializableChunkPlan(plan: ReviewDiffChunkPlan): unknown {
  return {
    stats: plan.stats,
    chunks: plan.chunks.map((chunk) => ({
      id: chunk.id,
      ordinal: chunk.ordinal,
      paths: chunk.paths,
      changedLines: chunk.changedLines,
      additions: chunk.additions,
      deletions: chunk.deletions,
      risk: chunk.risk,
      diffBytes: Buffer.byteLength(chunk.diffPatch, "utf8")
    }))
  };
}

function configuredReasoningEffort(): DemoReasoningEffort {
  const value = process.env.CODEX_MODEL_REASONING_EFFORT;
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : "high";
}

function reasoningEffortForDemoChunk(chunk: ReviewDiffChunk, contextPack: ContextPack): DemoReasoningEffort {
  const effort = configuredReasoningEffort();
  if (effort !== "high") return effort;
  if (chunkHasHighImpactHotspot(contextPack, chunk)) return "high";
  return "low";
}

async function runDemoReviewerChunk(params: {
  runCodexStage: DemoRunCodexStage;
  runDirectModelStage: DemoRunDirectModelStage;
  chunk: ReviewDiffChunk;
  chunkCount: number;
  totalChangedLines: number;
  repoPath: string;
  bundleDir: string;
  outDir: string;
  codexHomeDir: string;
  prMarkdown: string;
  diffWarnings: string[];
  contextPack: ContextPack;
  contextMode: DemoArgs["contextMode"];
  config: RepoConfig;
  prTitle: string;
  prBody: string;
  headSha: string;
  repoId: number;
  demoRunId: number;
}): Promise<ReviewChunkDraft> {
  const chunkBundleDir = path.join(params.bundleDir, "review_chunks", params.chunk.id);
  const chunkOutDir = path.join(params.outDir, "review_chunks", params.chunk.id);
  const chunkCodexHomeDir = path.join(params.codexHomeDir, "review_chunks", params.chunk.id);
  await fs.mkdir(chunkBundleDir, { recursive: true });
  await fs.mkdir(chunkOutDir, { recursive: true });
  await fs.mkdir(chunkCodexHomeDir, { recursive: true });
  const chunkContextPack =
    params.contextMode === "production" && params.repoId > 0
      ? await buildContextPackForChunk({
          repoId: params.repoId,
          chunk: params.chunk,
          config: params.config,
          prTitle: params.prTitle,
          prBody: params.prBody,
          fallbackContextPack: params.contextPack
        })
      : scopeContextPackToChunk(params.contextPack, params.chunk);
  await writeBundleFiles({
    bundleDir: chunkBundleDir,
    prMarkdown: params.prMarkdown,
    diffPatch: params.chunk.diffPatch,
    changedFiles: params.chunk.changedFiles,
    repoConfig: params.config,
    resolvedConfig: params.config,
    contextPack: chunkContextPack,
    warnings: params.diffWarnings
  });

  const promptPaths = { repoPath: params.repoPath, bundleDir: chunkBundleDir, outDir: chunkOutDir };
  const promptOptions = {
    chunkReview: {
      chunkId: params.chunk.id,
      ordinal: params.chunk.ordinal,
      totalChunks: params.chunkCount,
      changedLines: params.chunk.changedLines,
      totalChangedLines: params.totalChangedLines,
      paths: params.chunk.paths
    }
  };
  const reasoningEffort = reasoningEffortForDemoChunk(params.chunk, chunkContextPack);
  console.log(
    `[demo-review] reviewer ${params.chunk.id} files=${params.chunk.paths.length} ` +
      `changedLines=${params.chunk.changedLines} risk=${params.chunk.risk}`
  );
  try {
    await params.runDirectModelStage({
      stage: "reviewer",
      outDir: chunkOutDir,
      prompt: buildDirectReviewerPrompt({
        config: params.config,
        prMarkdown: params.prMarkdown,
        diffPatch: params.chunk.diffPatch,
        changedFiles: params.chunk.changedFiles,
        contextPack: chunkContextPack,
        warnings: params.diffWarnings,
        options: promptOptions
      }),
      reviewRunId: params.demoRunId,
      prNumber: 0,
      reasoningEffort,
      outputFileName: "draft_review.json"
    });
  } catch (err) {
    console.warn(
      `[demo-review] direct reviewer ${params.chunk.id} failed; falling back to codex: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    const reviewerPrompt = buildReviewerPrompt(params.config, promptPaths, promptOptions);
    await params.runCodexStage({
      stage: "reviewer",
      repoPath: params.repoPath,
      bundleDir: chunkBundleDir,
      outDir: chunkOutDir,
      codexHomeDir: chunkCodexHomeDir,
      prompt: reviewerPrompt,
      headSha: params.headSha,
      repoId: params.repoId,
      reviewRunId: params.demoRunId,
      prNumber: 0,
      reasoningEffort
    });
  }
  const review = await readAndValidateJsonWithFallback(
    path.join(chunkOutDir, "draft_review.json"),
    path.join(chunkOutDir, "last_message_reviewer.txt"),
    ReviewSchema
  );
  return { chunk: params.chunk, review };
}

async function loadDemoRepoConfigAtBase(
  repoPath: string,
  baseSha: string | null | undefined
) {
  return loadRepoConfigAtGitRef(repoPath, baseSha);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const repoPath = path.resolve(args.repoPath);
  if (args.contextMode === "production" && !args.repoId) {
    throw new Error(PRODUCTION_CONTEXT_REPO_ID_ERROR);
  }

  // Dynamic import to avoid triggering loadEnv() at module load time.
  // This allows the pure utility functions (parseCliArgs, buildEmptyContextPack,
  // formatTextOutput) to be imported and tested without env variables set.
  const { runCodexStage } = await import("../runner/codexRunner.js");
  const { runDirectModelStage } = await import("../runner/directModelRunner.js");

  console.log(`[demo-review] repo=${repoPath}`);

  const headSha = await resolveHeadSha(repoPath, args.head);
  const baseSha = await resolveBaseSha(repoPath, args.base);
  console.log(`[demo-review] base=${baseSha.slice(0, 12)} head=${headSha.slice(0, 12)}`);

  let diffPatch: string;
  if (args.diffFile) {
    diffPatch = await readDiffFileWithinLimit(path.resolve(args.diffFile));
    console.log(`[demo-review] diff loaded from file: ${args.diffFile}`);
  } else {
    diffPatch = await buildLocalDiffPatch({
      repoPath,
      baseSha,
      headSha,
      maxBytes: MAX_DEMO_DIFF_FILE_BYTES
    });
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

  const { config, warnings } = await loadDemoRepoConfigAtBase(repoPath, baseSha);
  if (warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`[demo-review] config warning: ${warning}`);
    }
  }

  const modelVisibleReviewData = sanitizeModelVisibleReviewData({
    diffPatch,
    changedFiles
  });
  diffPatch = modelVisibleReviewData.diffPatch;
  const sanitizedChangedFiles = modelVisibleReviewData.changedFiles;
  if (modelVisibleReviewData.sensitivePaths.length > 0) {
    console.log(
      `[demo-review] withheld ${modelVisibleReviewData.sensitivePaths.length} sensitive changed path(s) from model-visible context`
    );
  }
  if (modelVisibleReviewData.bulkNoisePaths.length > 0) {
    console.log(
      `[demo-review] omitted ${modelVisibleReviewData.bulkNoisePaths.length} bulk/noise changed path(s) from model-visible context`
    );
  }

  const demoPrTitle = "Demo Review";
  const demoPrBody = `Local review of ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}`;
  let contextPack: ContextPack;
  if (args.contextMode === "production") {
    if (!args.repoId) {
      throw new Error(PRODUCTION_CONTEXT_REPO_ID_ERROR);
    }
    const { buildContextPack } = await import("../review/context.js");
    console.log(`[demo-review] building production context repoId=${args.repoId}`);
    contextPack = await buildContextPack({
      repoId: args.repoId,
      diffPatch,
      changedFiles: sanitizedChangedFiles as Array<{
        filename?: string;
        path?: string;
        status?: string;
        additions?: number;
        deletions?: number;
      }>,
      prTitle: demoPrTitle,
      prBody: demoPrBody,
      retrieval: config.retrieval,
      graph: config.graph
    });
    console.log(
      `[demo-review] context retrieved=${contextPack.retrieved.length} related=${contextPack.relatedFiles.length} ` +
        `graphLinks=${contextPack.graphLinks.length} hotspots=${contextPack.hotspots.length}`
    );
  } else {
    console.warn("[demo-review] using empty context; this is for smoke tests, not production-equivalent benchmarking");
    contextPack = buildEmptyContextPack(
      diffPatch,
      sanitizedChangedFiles.filter((file): file is { path: string } => typeof file.path === "string")
    );
  }

  const demoRunId = Date.now();
  const runRoot = buildDemoRunRoot(repoPath);
  const { bundleDir, outDir, codexHomeDir } = await createRunDirs(runRoot, demoRunId);
  const stageRepoId = args.repoId ?? 0;

  const prMarkdown = renderPrMarkdown({
    title: demoPrTitle,
    number: 0,
    author: "local-demo",
    body: demoPrBody,
    baseRef: baseSha.slice(0, 12),
    headRef: headSha.slice(0, 12),
    headSha,
    sensitivePathsWithheld: modelVisibleReviewData.sensitivePaths
  });
  await writeBundleFiles({
    bundleDir,
    prMarkdown,
    diffPatch,
    changedFiles: sanitizedChangedFiles,
    repoConfig: config,
    resolvedConfig: config,
    contextPack,
    warnings
  });

  const promptPaths = { repoPath, bundleDir, outDir };

  const chunkPlan = buildReviewDiffChunkPlan({
    diffPatch,
    changedFiles: sanitizedChangedFiles,
    changedFileStats: contextPack.changedFileStats,
    targetChangedLines: CHUNKED_REVIEW_TARGET_CHANGED_LINES,
    maxChangedLines: CHUNKED_REVIEW_MAX_CHANGED_LINES,
    highRiskTargetChangedLines: CHUNKED_REVIEW_HIGH_TARGET_CHANGED_LINES,
    highRiskMaxChangedLines: CHUNKED_REVIEW_HIGH_MAX_CHANGED_LINES,
    maxFiles: CHUNKED_REVIEW_MAX_FILES
  });
  await fs.writeFile(
    path.join(outDir, "review_chunk_plan.json"),
    JSON.stringify(serializableChunkPlan(chunkPlan), null, 2),
    "utf8"
  );
  const shouldUseChunkedReviewer =
    chunkPlan.chunks.length > 1 &&
    chunkPlan.stats.totalChangedLines >= CHUNKED_REVIEW_MIN_CHANGED_LINES;
  let draft: ReviewOutput;
  if (shouldUseChunkedReviewer) {
    console.log(
      `[demo-review] running chunked reviewer chunks=${chunkPlan.chunks.length} ` +
        `changedLines=${chunkPlan.stats.totalChangedLines}`
    );
    const drafts = await mapWithConcurrency(
      chunkPlan.chunks,
      CHUNKED_REVIEW_MAX_PARALLEL,
      (chunk) =>
        runDemoReviewerChunk({
          runCodexStage,
          runDirectModelStage,
          chunk,
          chunkCount: chunkPlan.chunks.length,
          totalChangedLines: chunkPlan.stats.totalChangedLines,
          repoPath,
          bundleDir,
          outDir,
          codexHomeDir,
          prMarkdown,
          diffWarnings: warnings,
          contextPack,
          contextMode: args.contextMode,
          config,
          prTitle: demoPrTitle,
          prBody: demoPrBody,
          headSha,
          repoId: stageRepoId,
          demoRunId
        })
    );
    draft = mergeChunkReviewDrafts({
      drafts,
      maxKeyConcerns: config.limits.max_key_concerns
    });
    await fs.writeFile(path.join(outDir, "draft_review.json"), JSON.stringify(draft, null, 2), "utf8");
  } else {
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
      repoId: stageRepoId,
      reviewRunId: demoRunId,
      prNumber: 0
    });

    draft = await readAndValidateJsonWithFallback(
      path.join(outDir, "draft_review.json"),
      path.join(outDir, "last_message_reviewer.txt"),
      ReviewSchema
    );
  }

  console.log("[demo-review] applying editor pass...");
  let finalReview: ReviewOutput;
  if (shouldUseChunkedReviewer) {
    const editorInput = buildCompactEditorInput({
      draft,
      maxComments: Math.max(
        config.limits.max_inline_comments,
        Math.min(CHUNKED_EDITOR_MAX_CANDIDATE_COMMENTS, config.limits.max_inline_comments * 2)
      )
    });
    await fs.writeFile(path.join(outDir, "editor_input.json"), JSON.stringify(editorInput, null, 2), "utf8");
    const decisionOutput = buildDeterministicEditorDecisionOutput(editorInput);
    await fs.writeFile(
      path.join(outDir, "editor_decision.json"),
      JSON.stringify(decisionOutput, null, 2),
      "utf8"
    );
    const applied = applyEditorDecisionOutput({ draft, editorInput, decisionOutput });
    finalReview = applied.finalReview;
    await fs.writeFile(path.join(outDir, "final_review.json"), JSON.stringify(finalReview, null, 2), "utf8");
    await fs.writeFile(path.join(outDir, "verdicts.json"), JSON.stringify(applied.verdicts, null, 2), "utf8");
  } else {
    const editorPrompt = buildEditorPrompt(JSON.stringify(draft, null, 2), promptPaths);
    await runCodexStage({
      stage: "editor",
      repoPath,
      bundleDir,
      outDir,
      codexHomeDir,
      prompt: editorPrompt,
      headSha,
      repoId: stageRepoId,
      reviewRunId: demoRunId,
      prNumber: 0
    });

    finalReview = await readAndValidateJsonWithFallback(
      path.join(outDir, "final_review.json"),
      path.join(outDir, "last_message_editor.txt"),
      ReviewSchema
    );
  }

  const diffIndex = buildDiffIndex(diffPatch);
  const { comments, diagnostics } = refineReviewComments({
    comments: finalReview.comments,
    diffIndex,
    changedFiles: sanitizedChangedFiles,
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
  buildDemoRunRoot,
  buildEmptyContextPack,
  formatTextOutput,
  readDiffFileWithinLimit,
  loadDemoRepoConfigAtBase,
  resolveBaseSha,
  resolveHeadSha
};

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  main()
    .catch((error) => {
      console.error("[demo-review] failed", error);
      process.exitCode = 1;
    });
}
