import "dotenv/config";

import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import { execa } from "execa";
import { gitCheckoutSafetyEnv } from "../github/gitAuth.js";
import { buildLocalChangedFiles, buildLocalDiffPatch } from "../review/localCompare.js";
import type {
  ProviderAdapter,
  ProviderClient,
  ProviderCommit,
  ProviderPullRequest,
  ProviderRepo,
  ProviderReviewComment,
  ProviderStatusCheck
} from "../providers/types.js";

const ArgsSchema = z.object({
  repoPath: z.string().min(1),
  base: z.string().optional(),
  head: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  bodyFile: z.string().optional(),
  output: z.string().optional(),
  format: z.enum(["json", "text"]).default("json"),
  repoId: z.number().int().positive().optional(),
  prNumber: z.number().int().nonnegative().optional(),
  trigger: z.enum(["opened", "reopened", "ready_for_review", "synchronize", "manual"]).default("opened"),
  force: z.boolean().default(true),
  indexMode: z.enum(["auto", "always", "never"]).default("auto"),
  keepWorktrees: z.boolean().default(false)
});

type BenchmarkArgs = z.infer<typeof ArgsSchema>;

type BenchmarkRecords = {
  providerId: number;
  repoId: number;
  repo: ProviderRepo;
  installationId: string | null;
  pullRequestId: number;
  prNumber: number;
};

type BenchmarkRunResult = {
  run: {
    id: number;
    status: string;
    headSha: string;
    trigger: string;
    startedAt: Date | null;
    completedAt: Date | null;
    summaryJson: unknown;
    finalJson: unknown;
    checksJson: unknown;
  };
  repoId: number;
  pullRequestId: number;
  prNumber: number;
  statusComment: { id: string; body: string; url?: string | null } | null;
  inlineComments: Array<{
    id: string;
    body: string;
    url?: string | null;
    finding?: BenchmarkFinding | null;
  }>;
  findings: BenchmarkFinding[];
  agenticArtifacts?: BenchmarkAgenticArtifacts;
};

type BenchmarkAgenticArtifacts = {
  enabled: boolean;
  chunkDiagnostics: Array<{
    path: string;
    chunkId?: string;
    grCommands?: string[];
    shellCommands?: string[];
    retrievalCalls?: number;
    graphCalls?: number;
    findingsCiteInspectedEvidence?: boolean;
  }>;
};

type BenchmarkFinding = {
  id: number;
  status: string;
  path: string;
  line: number;
  side: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  evidence: string;
  suggestedPatch?: string | null;
  ruleId?: string | null;
  ruleReason?: string | null;
};

const FLAG_MAP: Record<string, string> = {
  "--repo-path": "repoPath",
  "--base": "base",
  "--head": "head",
  "--title": "title",
  "--body": "body",
  "--body-file": "bodyFile",
  "--output": "output",
  "--format": "format",
  "--repo-id": "repoId",
  "--pr-number": "prNumber",
  "--trigger": "trigger",
  "--index-mode": "indexMode"
};

const BOOLEAN_FLAGS: Record<string, [field: string, value: boolean]> = {
  "--force": ["force", true],
  "--no-force": ["force", false],
  "--index": ["indexMode", true],
  "--no-index": ["indexMode", false],
  "--keep-worktrees": ["keepWorktrees", true]
};

function parseBooleanFlag(value: string, flag: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value for ${flag}: ${value}`);
}

export function parseCliArgs(argv: string[]): BenchmarkArgs {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);
      const booleanFlag = BOOLEAN_FLAGS[key];
      if (booleanFlag) {
        const [field] = booleanFlag;
        raw[field] = parseBooleanFlag(value, key);
        continue;
      }
      const field = FLAG_MAP[key];
      if (field) {
        raw[field] = value;
        continue;
      }
    }

    const booleanFlag = BOOLEAN_FLAGS[arg];
    if (booleanFlag) {
      const [field, value] = booleanFlag;
      raw[field] = field === "indexMode" ? (value ? "always" : "never") : value;
      continue;
    }

    const field = FLAG_MAP[arg];
    if (field && i + 1 < argv.length) {
      raw[field] = argv[++i];
    }
  }

  if (typeof raw.repoId === "string") raw.repoId = Number(raw.repoId);
  if (typeof raw.prNumber === "string") raw.prNumber = Number(raw.prNumber);
  if (raw.indexMode === true) raw.indexMode = "always";
  if (raw.indexMode === false) raw.indexMode = "never";
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
      { env: gitCheckoutSafetyEnv(sourceEnv) }
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

export async function resolveHeadSha(
  repoPath: string,
  head?: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (head) return resolveGitSha(repoPath, head, sourceEnv);
  return resolveGitSha(repoPath, "HEAD", sourceEnv);
}

export async function resolveBaseSha(
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

export function buildBenchmarkRoot(repoPath: string): string {
  const resolvedRepoPath = path.resolve(repoPath);
  const digest = crypto
    .createHash("sha256")
    .update(resolvedRepoPath)
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), "grepiku-benchmark", digest);
}

function stableBenchmarkExternalId(repoPath: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(path.resolve(repoPath))
    .digest("hex")
    .slice(0, 24);
  return `benchmark:${digest}`;
}

function sanitizeRepoName(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "local-repo";
}

async function resolveDefaultBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], {
      env: gitCheckoutSafetyEnv()
    });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

async function createCleanWorktree(params: {
  sourceRepoPath: string;
  root: string;
  name: string;
  sha: string;
}): Promise<string> {
  const worktreePath = path.join(params.root, "worktrees", `${params.name}-${params.sha.slice(0, 12)}`);
  await fs.rm(worktreePath, { recursive: true, force: true });
  await execa("git", ["-C", params.sourceRepoPath, "worktree", "prune"], {
    env: gitCheckoutSafetyEnv(),
    stdio: "ignore"
  }).catch(() => undefined);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await execa("git", ["-C", params.sourceRepoPath, "worktree", "add", "--detach", worktreePath, params.sha], {
    env: gitCheckoutSafetyEnv(),
    stdio: "ignore"
  });
  return worktreePath;
}

async function removeCleanWorktree(sourceRepoPath: string, worktreePath: string): Promise<void> {
  await execa("git", ["-C", sourceRepoPath, "worktree", "remove", "--force", worktreePath], {
    env: gitCheckoutSafetyEnv(),
    stdio: "ignore"
  }).catch(() => undefined);
  await fs.rm(worktreePath, { recursive: true, force: true });
}

async function readBody(args: BenchmarkArgs, baseSha: string, headSha: string): Promise<string> {
  if (args.bodyFile) {
    return fs.readFile(path.resolve(args.bodyFile), "utf8");
  }
  if (args.body != null) return args.body;
  return `Local benchmark review of ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}`;
}

async function gitCommitInfo(repoPath: string, sha: string): Promise<ProviderCommit> {
  const [messageResult, parentsResult, authorResult] = await Promise.allSettled([
    execa("git", ["-C", repoPath, "show", "-s", "--format=%B", sha], { env: gitCheckoutSafetyEnv() }),
    execa("git", ["-C", repoPath, "rev-list", "--parents", "-n", "1", sha], { env: gitCheckoutSafetyEnv() }),
    execa("git", ["-C", repoPath, "show", "-s", "--format=%an", sha], { env: gitCheckoutSafetyEnv() })
  ]);
  const message = messageResult.status === "fulfilled" ? messageResult.value.stdout.trim() : "";
  const parentLine = parentsResult.status === "fulfilled" ? parentsResult.value.stdout.trim() : "";
  const parentCount = parentLine ? Math.max(0, parentLine.split(/\s+/).length - 1) : undefined;
  const authorLogin = authorResult.status === "fulfilled" ? authorResult.value.stdout.trim() : null;
  return { sha, message, authorLogin, parentCount };
}

function nextSyntheticId(prefix: string, counter: { value: number }): string {
  counter.value += 1;
  return `benchmark-${prefix}-${counter.value}`;
}

export function createBenchmarkProviderAdapter(params: {
  sourceRepoPath: string;
  headWorktreePath: string;
  baseSha: string;
  headSha: string;
  repo: ProviderRepo;
  pullRequest: ProviderPullRequest;
  botLogin: string;
}): ProviderAdapter {
  const counter = { value: 0 };
  let pullRequestBody = params.pullRequest.body || "";
  const summaryComments = new Map<string, ProviderReviewComment>();
  const inlineComments = new Map<string, ProviderReviewComment>();
  const statusChecks = new Map<string, ProviderStatusCheck>();

  const clonePullRequest = (): ProviderPullRequest => ({
    ...params.pullRequest,
    body: pullRequestBody
  });

  const createClient = (): ProviderClient => ({
    provider: "github",
    repo: params.repo,
    pullRequest: clonePullRequest(),
    fetchPullRequest: async () => clonePullRequest(),
    fetchCommit: async (sha) => gitCommitInfo(params.sourceRepoPath, sha),
    fetchDiffPatch: async () =>
      buildLocalDiffPatch({
        repoPath: params.headWorktreePath,
        baseSha: params.baseSha,
        headSha: params.headSha
      }),
    listChangedFiles: async () =>
      buildLocalChangedFiles({
        repoPath: params.headWorktreePath,
        baseSha: params.baseSha,
        headSha: params.headSha
      }),
    ensureRepoCheckout: async () => params.headWorktreePath,
    updatePullRequestBody: async (body) => {
      pullRequestBody = body;
    },
    createSummaryComment: async (body) => {
      const comment: ProviderReviewComment = {
        id: nextSyntheticId("summary", counter),
        body,
        url: null,
        authorLogin: params.botLogin
      };
      summaryComments.set(comment.id, comment);
      return comment;
    },
    updateSummaryComment: async (commentId, body) => {
      const existing = summaryComments.get(commentId);
      if (!existing) throw new Error(`Unknown benchmark summary comment: ${commentId}`);
      const updated = { ...existing, body };
      summaryComments.set(commentId, updated);
      return updated;
    },
    createInlineComment: async ({ path: commentPath, line, side, body }) => {
      const comment: ProviderReviewComment = {
        id: nextSyntheticId("inline", counter),
        body,
        url: null,
        path: commentPath,
        line,
        side,
        authorLogin: params.botLogin
      };
      inlineComments.set(comment.id, comment);
      return comment;
    },
    listInlineComments: async (filter) => {
      const comments = Array.from(inlineComments.values());
      return comments.filter((comment) => {
        if (filter?.bodyIncludes && !comment.body.includes(filter.bodyIncludes)) return false;
        if (filter?.authorLogin && comment.authorLogin !== filter.authorLogin) return false;
        return true;
      });
    },
    updateInlineComment: async (commentId, body) => {
      const existing = inlineComments.get(commentId);
      if (!existing) throw new Error(`Unknown benchmark inline comment: ${commentId}`);
      const updated = { ...existing, body };
      inlineComments.set(commentId, updated);
      return updated;
    },
    resolveInlineThread: async () => true,
    createStatusCheck: async (check) => {
      const id = nextSyntheticId("check", counter);
      const created = { ...check, id };
      statusChecks.set(id, created);
      return created;
    },
    updateStatusCheck: async (checkId, check) => {
      const updated = { ...check, id: checkId };
      statusChecks.set(checkId, updated);
      return updated;
    }
  });

  return {
    kind: "github",
    verifyWebhook: async () => null,
    createClient: async () => createClient()
  };
}

function shouldIndexForBenchmark(args: BenchmarkArgs): boolean {
  if (args.indexMode === "always") return true;
  if (args.indexMode === "never") return false;
  return !args.repoId;
}

async function ensureBenchmarkRecords(params: {
  args: BenchmarkArgs;
  repoPath: string;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
}): Promise<BenchmarkRecords> {
  const { prisma } = await import("../db/client.js");
  const {
    ensureInstallation,
    ensureProvider,
    ensureRepo,
    ensureRepoInstallation,
    ensureUser,
    upsertPullRequest
  } = await import("../db/records.js");

  let repoRow: Awaited<ReturnType<typeof ensureRepo>>;
  let installationExternalId: string | null = null;
  if (params.args.repoId) {
    const existing = await prisma.repo.findUnique({
      where: { id: params.args.repoId },
      include: { installations: { include: { installation: true }, take: 1 } }
    });
    if (!existing) {
      throw new Error(`No repo found for --repo-id=${params.args.repoId}`);
    }
    repoRow = existing;
    installationExternalId = existing.installations[0]?.installation.externalId || null;
  } else {
    const provider = await ensureProvider({
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
      apiUrl: null
    });
    const repoName = sanitizeRepoName(path.basename(params.repoPath));
    const externalId = stableBenchmarkExternalId(params.repoPath);
    const defaultBranch = await resolveDefaultBranch(params.repoPath);
    repoRow = await ensureRepo({
      providerId: provider.id,
      externalId,
      owner: "benchmark",
      name: repoName,
      fullName: `benchmark/${repoName}`,
      defaultBranch,
      private: true
    });
    installationExternalId = externalId;
  }

  if (!installationExternalId) {
    installationExternalId = stableBenchmarkExternalId(params.repoPath);
  }

  const installation = await ensureInstallation({
    providerId: repoRow.providerId,
    externalId: installationExternalId,
    accountLogin: repoRow.owner || "benchmark",
    accountType: "benchmark"
  });
  await ensureRepoInstallation({ repoId: repoRow.id, installationId: installation.id });

  const author = await ensureUser({
    providerId: repoRow.providerId,
    externalId: "benchmark-local-user",
    login: "benchmark-local",
    name: "Benchmark Local",
    avatarUrl: null
  });

  const prNumber = params.args.prNumber ?? Math.floor(Date.now() / 1000);
  const pullRequest = await upsertPullRequest({
    repoId: repoRow.id,
    externalId: `benchmark:${repoRow.externalId}:${prNumber}`,
    number: prNumber,
    title: params.title,
    body: params.body,
    url: null,
    state: "open",
    baseRef: params.args.base || params.baseSha.slice(0, 12),
    headRef: params.args.head || params.headSha.slice(0, 12),
    baseSha: params.baseSha,
    headSha: params.headSha,
    draft: false,
    authorId: author.id
  });

  return {
    providerId: repoRow.providerId,
    repoId: repoRow.id,
    repo: {
      externalId: repoRow.externalId,
      owner: repoRow.owner,
      name: repoRow.name,
      fullName: repoRow.fullName,
      defaultBranch: repoRow.defaultBranch,
      archived: repoRow.archived,
      private: repoRow.private
    },
    installationId: installationExternalId,
    pullRequestId: pullRequest.id,
    prNumber
  };
}

async function indexBenchmarkBase(params: {
  repoId: number;
  baseWorktreePath: string;
}): Promise<void> {
  const { indexLocalRepoPathForBenchmark } = await import("../services/indexer.js");
  const { processGraphJob } = await import("../services/graph.js");
  await indexLocalRepoPathForBenchmark({
    repoId: params.repoId,
    repoPath: params.baseWorktreePath,
    force: true
  });
  await processGraphJob({ repoId: params.repoId });
}

function normalizeFinding(row: any): BenchmarkFinding {
  return {
    id: row.id,
    status: row.status,
    path: row.path,
    line: row.line,
    side: row.side,
    severity: row.severity,
    category: row.category,
    title: row.title,
    body: row.body,
    evidence: row.evidence,
    suggestedPatch: row.suggestedPatch,
    ruleId: row.ruleId,
    ruleReason: row.ruleReason
  };
}

async function loadBenchmarkResult(params: {
  pullRequestId: number;
  headSha: string;
}): Promise<BenchmarkRunResult> {
  const { prisma } = await import("../db/client.js");
  const run = await prisma.reviewRun.findFirst({
    where: { pullRequestId: params.pullRequestId, headSha: params.headSha },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      headSha: true,
      trigger: true,
      startedAt: true,
      completedAt: true,
      summaryJson: true,
      finalJson: true,
      checksJson: true,
      pullRequestId: true,
      pullRequest: { select: { repoId: true, number: true } }
    }
  });
  if (!run) {
    throw new Error("Benchmark run did not create a review run");
  }

  const [comments, findings] = await Promise.all([
    prisma.reviewComment.findMany({
      where: { pullRequestId: params.pullRequestId },
      include: { finding: true },
      orderBy: { id: "asc" }
    }),
    prisma.finding.findMany({
      where: {
        pullRequestId: params.pullRequestId,
        OR: [{ reviewRunId: run.id }, { lastSeenRunId: run.id }]
      },
      orderBy: [{ path: "asc" }, { line: "asc" }, { id: "asc" }]
    })
  ]);

  const currentFindingIds = new Set(findings.map((finding) => finding.id));
  const statusComment = comments
    .filter((comment) => comment.kind === "summary")
    .at(-1);
  const inlineComments = comments
    .filter(
      (comment) =>
        comment.kind === "inline" &&
        comment.finding &&
        currentFindingIds.has(comment.finding.id)
    )
    .map((comment) => ({
      id: comment.providerCommentId,
      body: comment.body,
      url: comment.url,
      finding: comment.finding ? normalizeFinding(comment.finding) : null
    }));

  return {
    run: {
      id: run.id,
      status: run.status,
      headSha: run.headSha,
      trigger: run.trigger,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      summaryJson: run.summaryJson,
      finalJson: run.finalJson,
      checksJson: run.checksJson
    },
    repoId: run.pullRequest.repoId,
    pullRequestId: run.pullRequestId,
    prNumber: run.pullRequest.number,
    statusComment: statusComment
      ? {
          id: statusComment.providerCommentId,
          body: statusComment.body,
          url: statusComment.url
        }
      : null,
    inlineComments,
    findings: findings.map(normalizeFinding),
    agenticArtifacts: await collectBenchmarkAgenticArtifacts(run.id)
  };
}

export async function collectBenchmarkAgenticArtifacts(
  runId: number,
  projectRoot = process.env.PROJECT_ROOT || process.cwd()
): Promise<BenchmarkAgenticArtifacts> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const runRoot = path.join(resolvedProjectRoot, "var", "runs", String(runId), "out", "review_chunks");
  const diagnostics: BenchmarkAgenticArtifacts["chunkDiagnostics"] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.name !== "agentic_reviewer_diagnostics.json") continue;
      const parsed = JSON.parse(await fs.readFile(fullPath, "utf8"));
      diagnostics.push({
        path: path.relative(resolvedProjectRoot, fullPath),
        chunkId: typeof parsed.chunkId === "string" ? parsed.chunkId : undefined,
        grCommands: Array.isArray(parsed.grCommands) ? parsed.grCommands : undefined,
        shellCommands: Array.isArray(parsed.shellCommands) ? parsed.shellCommands : undefined,
        retrievalCalls: typeof parsed.retrievalCalls === "number" ? parsed.retrievalCalls : undefined,
        graphCalls: typeof parsed.graphCalls === "number" ? parsed.graphCalls : undefined,
        findingsCiteInspectedEvidence: typeof parsed.findingsCiteInspectedEvidence === "boolean" ? parsed.findingsCiteInspectedEvidence : undefined
      });
    }
  }
  await walk(runRoot);
  return { enabled: diagnostics.length > 0, chunkDiagnostics: diagnostics.sort((a, b) => a.path.localeCompare(b.path)) };
}

function formatBenchmarkTextOutput(result: BenchmarkRunResult): string {
  const lines: string[] = [];
  lines.push("=== Benchmark Review ===");
  lines.push(`Run: ${result.run.id} (${result.run.status})`);
  lines.push(`Repo: ${result.repoId}  PR: #${result.prNumber}  Head: ${result.run.headSha.slice(0, 12)}`);
  lines.push("");
  if (result.statusComment?.body) {
    lines.push(result.statusComment.body);
    lines.push("");
  }
  if (result.agenticArtifacts?.enabled) {
    lines.push(`Agentic chunks: ${result.agenticArtifacts.chunkDiagnostics.length}`);
  }
  if (result.findings.length === 0) {
    lines.push("No persisted findings.");
  } else {
    lines.push(`Persisted findings (${result.findings.length}):`);
    for (const finding of result.findings) {
      lines.push(`- [${finding.severity.toUpperCase()}] ${finding.path}:${finding.line} ${finding.title}`);
    }
  }
  return lines.join("\n");
}

async function runBenchmark(args: BenchmarkArgs): Promise<BenchmarkRunResult> {
  const repoPath = path.resolve(args.repoPath);
  const headSha = await resolveHeadSha(repoPath, args.head);
  const baseSha = await resolveBaseSha(repoPath, args.base);
  const benchmarkRoot = buildBenchmarkRoot(repoPath);
  const title = args.title || "Benchmark Review";
  const body = await readBody(args, baseSha, headSha);
  const botLogin = "grepiku-benchmark";

  console.log(`[benchmark-mode] repo=${repoPath}`);
  console.log(`[benchmark-mode] base=${baseSha.slice(0, 12)} head=${headSha.slice(0, 12)}`);

  const records = await ensureBenchmarkRecords({
    args,
    repoPath,
    baseSha,
    headSha,
    title,
    body
  });

  const baseWorktreePath = await createCleanWorktree({
    sourceRepoPath: repoPath,
    root: benchmarkRoot,
    name: "base",
    sha: baseSha
  });
  const headWorktreePath = await createCleanWorktree({
    sourceRepoPath: repoPath,
    root: benchmarkRoot,
    name: "head",
    sha: headSha
  });

  try {
    if (shouldIndexForBenchmark(args)) {
      console.log(`[benchmark-mode] indexing local base checkout for repoId=${records.repoId}`);
      await indexBenchmarkBase({ repoId: records.repoId, baseWorktreePath });
    } else {
      console.log(`[benchmark-mode] using existing index for repoId=${records.repoId}`);
    }

    const pullRequest: ProviderPullRequest = {
      externalId: `benchmark:${records.repo.externalId}:${records.prNumber}`,
      number: records.prNumber,
      title,
      body,
      url: null,
      state: "open",
      baseRef: args.base || baseSha.slice(0, 12),
      headRef: args.head || headSha.slice(0, 12),
      headRepoFullName: records.repo.fullName,
      baseSha,
      headSha,
      draft: false,
      author: {
        externalId: "benchmark-local-user",
        login: "benchmark-local",
        name: "Benchmark Local",
        avatarUrl: null
      },
      labels: []
    };

    const adapter = createBenchmarkProviderAdapter({
      sourceRepoPath: repoPath,
      headWorktreePath,
      baseSha,
      headSha,
      repo: records.repo,
      pullRequest,
      botLogin
    });

    const { processReviewJob } = await import("../review/pipeline.js");
    await processReviewJob(
      {
        provider: "github",
        installationId: records.installationId,
        repoId: records.repoId,
        pullRequestId: records.pullRequestId,
        prNumber: records.prNumber,
        headSha,
        trigger: args.trigger,
        force: args.force
      },
      {
        adapter,
        resolveBotLogin: async () => botLogin,
        enqueueIndexJob: async (data) => {
          console.log(`[benchmark-mode] skipped enqueue index job ${JSON.stringify(data)}`);
        },
        enqueueAnalyticsJob: async (data) => {
          console.log(`[benchmark-mode] skipped enqueue analytics job ${JSON.stringify(data)}`);
        }
      }
    );

    return loadBenchmarkResult({ pullRequestId: records.pullRequestId, headSha });
  } finally {
    if (!args.keepWorktrees) {
      await removeCleanWorktree(repoPath, headWorktreePath);
      await removeCleanWorktree(repoPath, baseWorktreePath);
    }
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runBenchmark(args);
  const output = args.format === "text" ? formatBenchmarkTextOutput(result) : JSON.stringify(result, null, 2);
  if (args.output) {
    await fs.writeFile(path.resolve(args.output), output, "utf8");
    console.log(`[benchmark-mode] output written to ${args.output}`);
  } else {
    console.log(output);
  }
  console.log("[benchmark-mode] done");
}

export const __benchmarkModeInternals = {
  parseCliArgs,
  buildBenchmarkRoot,
  createBenchmarkProviderAdapter,
  formatBenchmarkTextOutput,
  resolveBaseSha,
  resolveHeadSha,
  collectBenchmarkAgenticArtifacts
};

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error("[benchmark-mode] failed", error);
    process.exitCode = 1;
  });
}
