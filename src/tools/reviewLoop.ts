import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { enqueueIndexJob, enqueueReviewJob } from "../queue/enqueue.js";
import type { RepoConfig } from "../review/config.js";

const env = loadEnv();

const LoopEnvSchema = z.object({
  REVIEW_LOOP_REPO_ID: z.string().optional(),
  REVIEW_LOOP_REPO_FULL_NAME: z.string().optional(),
  REVIEW_LOOP_PR_NUMBER: z.string().optional(),
  REVIEW_LOOP_INSTALLATION_ID: z.string().optional(),
  REVIEW_LOOP_MAX_CYCLES: z.string().default("40"),
  REVIEW_LOOP_POLL_MS: z.string().default("15000"),
  REVIEW_LOOP_TIMEOUT_MS: z.string().default("1800000"),
  REVIEW_LOOP_PAUSE_MS: z.string().default("30000"),
  REVIEW_LOOP_FORCE_INDEX_EVERY: z.string().default("3")
});

type CycleMetrics = {
  cycle: number;
  startedAt: string;
  runId: number;
  runStatus: string;
  durationMs: number;
  findingsOpenInRun: number;
  openFindingsInPr: number;
  positiveFeedback: number;
  negativeFeedback: number;
  retrieval: RepoConfig["retrieval"];
  tuned: boolean;
};

const POSITIVE = new Set(["thumbs_up", "+1", "heart", "hooray", "resolved"]);
const NEGATIVE = new Set(["thumbs_down", "-1", "confused"]);

const DEFAULT_RETRIEVAL: RepoConfig["retrieval"] = {
  topK: 18,
  maxPerPath: 4,
  semanticWeight: 0.62,
  lexicalWeight: 0.22,
  rrfWeight: 0.08,
  changedPathBoost: 0.16,
  sameDirectoryBoost: 0.08,
  patternBoost: 0.03,
  symbolBoost: 0.02,
  chunkBoost: 0.03
};

const DEFAULT_REPO_CONFIG: RepoConfig = {
  ignore: ["node_modules/**", "dist/**"],
  tools: {},
  limits: { max_inline_comments: 20, max_key_concerns: 5 },
  rules: [],
  scopes: [],
  patternRepositories: [],
  strictness: "medium",
  commentTypes: { allow: ["inline", "summary"] },
  output: { summaryOnly: false, destination: "both" },
  retrieval: DEFAULT_RETRIEVAL,
  statusChecks: { name: "Grepiku Review", required: false },
  triggers: {
    manualOnly: false,
    allowAutoOnPush: true,
    labels: { include: [], exclude: [] },
    branches: { include: [], exclude: [] },
    authors: { include: [], exclude: [] },
    keywords: { include: [], exclude: [] },
    commentTriggers: ["/review", "@grepiku"]
  }
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isoStamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

async function resolveTarget(params: {
  repoId?: number;
  repoFullName?: string;
  prNumber?: number;
}) {
  let repo = null as Awaited<ReturnType<typeof prisma.repo.findFirst>> | null;
  if (params.repoId) {
    repo = await prisma.repo.findFirst({ where: { id: params.repoId } });
  } else if (params.repoFullName) {
    if (params.prNumber) {
      const prWithRepo = await prisma.pullRequest.findFirst({
        where: { number: params.prNumber, repo: { fullName: params.repoFullName } },
        orderBy: { updatedAt: "desc" },
        include: { repo: true }
      });
      repo = prWithRepo?.repo || null;
    } else {
      const openPrWithRepo = await prisma.pullRequest.findFirst({
        where: { state: "open", repo: { fullName: params.repoFullName } },
        orderBy: { updatedAt: "desc" },
        include: { repo: true }
      });
      repo =
        openPrWithRepo?.repo ||
        (await prisma.repo.findFirst({
          where: { fullName: params.repoFullName },
          orderBy: { updatedAt: "desc" }
        }));
    }
  }

  if (!repo) {
    throw new Error("review-loop: target repo not found (set REVIEW_LOOP_REPO_ID or REVIEW_LOOP_REPO_FULL_NAME)");
  }

  const pullRequest = params.prNumber
    ? await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: params.prNumber } })
    : await prisma.pullRequest.findFirst({ where: { repoId: repo.id, state: "open" }, orderBy: { updatedAt: "desc" } });

  if (!pullRequest) {
    throw new Error("review-loop: target pull request not found (set REVIEW_LOOP_PR_NUMBER)");
  }

  const installation = await prisma.repoInstallation.findFirst({
    where: { repoId: repo.id },
    include: { installation: true }
  });

  return {
    repo,
    pullRequest,
    installationExternalId: installation?.installation.externalId || null
  };
}

async function waitForRunCompletion(params: {
  pullRequestId: number;
  headSha: string;
  cycleStartedAt: Date;
  pollMs: number;
  timeoutMs: number;
}) {
  const threshold = new Date(params.cycleStartedAt.getTime() - 5000);
  const deadline = Date.now() + params.timeoutMs;

  while (Date.now() < deadline) {
    const run = await prisma.reviewRun.findFirst({
      where: {
        pullRequestId: params.pullRequestId,
        headSha: params.headSha
      },
      orderBy: { createdAt: "desc" }
    });

    if (run && run.startedAt && run.startedAt >= threshold && (run.status === "completed" || run.status === "failed")) {
      return run;
    }
    await sleep(params.pollMs);
  }

  throw new Error(`review-loop: timed out waiting for run completion after ${params.timeoutMs}ms`);
}

function ensureRetrievalConfig(config: RepoConfig): RepoConfig["retrieval"] {
  return config.retrieval || DEFAULT_RETRIEVAL;
}

function tuneRetrieval(params: {
  current: RepoConfig["retrieval"];
  positiveFeedback: number;
  negativeFeedback: number;
  openFindingsInPr: number;
}): { next: RepoConfig["retrieval"]; tuned: boolean } {
  const { current, positiveFeedback, negativeFeedback, openFindingsInPr } = params;
  const totalFeedback = positiveFeedback + negativeFeedback;
  const negativeRate = totalFeedback > 0 ? negativeFeedback / totalFeedback : 0;
  const positiveRate = totalFeedback > 0 ? positiveFeedback / totalFeedback : 0;

  const next: RepoConfig["retrieval"] = { ...current };

  if (negativeRate >= 0.45) {
    next.lexicalWeight = Math.max(0.14, Number((next.lexicalWeight - 0.02).toFixed(2)));
    next.semanticWeight = Math.min(0.74, Number((next.semanticWeight + 0.02).toFixed(2)));
    next.maxPerPath = Math.max(2, next.maxPerPath - 1);
    next.topK = Math.min(30, next.topK + 2);
  } else if (positiveRate >= 0.55) {
    next.topK = Math.min(32, next.topK + 1);
    next.maxPerPath = Math.min(6, next.maxPerPath + 1);
    next.chunkBoost = Math.min(0.08, Number((next.chunkBoost + 0.01).toFixed(2)));
  }

  if (openFindingsInPr > 20) {
    next.topK = Math.min(34, next.topK + 1);
    next.changedPathBoost = Math.min(0.24, Number((next.changedPathBoost + 0.01).toFixed(2)));
  }

  const tuned = JSON.stringify(current) !== JSON.stringify(next);
  return { next, tuned };
}

async function collectFeedback(repoId: number) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const feedback = await prisma.feedback.findMany({
    where: {
      createdAt: { gte: since },
      reviewRun: { pullRequest: { repoId } }
    },
    orderBy: { createdAt: "desc" },
    take: 400
  });

  let positive = 0;
  let negative = 0;
  for (const item of feedback) {
    if (item.type === "reaction" && item.sentiment) {
      if (POSITIVE.has(item.sentiment)) positive += 1;
      if (NEGATIVE.has(item.sentiment)) negative += 1;
    }
    if (item.type === "reply" && item.action && POSITIVE.has(item.action)) {
      positive += 1;
    }
  }
  return { positive, negative };
}

async function upsertRepoConfig(repoId: number, config: RepoConfig) {
  const existing = await prisma.repoConfig.findFirst({ where: { repoId } });
  if (existing) {
    await prisma.repoConfig.update({
      where: { id: existing.id },
      data: {
        configJson: config,
        warnings: existing.warnings || []
      }
    });
    return;
  }
  await prisma.repoConfig.create({
    data: {
      repoId,
      configJson: config,
      warnings: []
    }
  });
}

async function main() {
  const parsedEnv = LoopEnvSchema.parse(process.env);
  const repoId = parsedEnv.REVIEW_LOOP_REPO_ID ? Number(parsedEnv.REVIEW_LOOP_REPO_ID) : undefined;
  const prNumber = parsedEnv.REVIEW_LOOP_PR_NUMBER ? Number(parsedEnv.REVIEW_LOOP_PR_NUMBER) : undefined;
  const maxCycles = toNumber(parsedEnv.REVIEW_LOOP_MAX_CYCLES, 40);
  const pollMs = toNumber(parsedEnv.REVIEW_LOOP_POLL_MS, 15000);
  const timeoutMs = toNumber(parsedEnv.REVIEW_LOOP_TIMEOUT_MS, 1800000);
  const pauseMs = toNumber(parsedEnv.REVIEW_LOOP_PAUSE_MS, 30000);
  const forceIndexEvery = toNumber(parsedEnv.REVIEW_LOOP_FORCE_INDEX_EVERY, 3);

  const target = await resolveTarget({
    repoId,
    repoFullName: parsedEnv.REVIEW_LOOP_REPO_FULL_NAME,
    prNumber
  });

  const preferredOutputDir = path.join(env.projectRoot, "var", "loop");
  const fallbackOutputDir = path.join("/tmp", "grepiku-loop");
  let outputDir = preferredOutputDir;
  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch {
    outputDir = fallbackOutputDir;
    await fs.mkdir(outputDir, { recursive: true });
    console.warn(`[review-loop] output dir not writable: ${preferredOutputDir}; falling back to ${fallbackOutputDir}`);
  }
  const outputPath = path.join(
    outputDir,
    `review-loop-${target.repo.fullName.replace(/[^a-zA-Z0-9._-]/g, "_")}-pr${target.pullRequest.number}-${isoStamp(new Date())}.jsonl`
  );

  console.log(
    `[review-loop] target=${target.repo.fullName}(repoId=${target.repo.id})#${target.pullRequest.number} maxCycles=${maxCycles} pollMs=${pollMs} timeoutMs=${timeoutMs}`
  );
  console.log(`[review-loop] writing cycle logs to ${outputPath}`);

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const cycleStartedAt = new Date();
    const pr = await prisma.pullRequest.findFirst({ where: { id: target.pullRequest.id } });
    if (!pr || !pr.headSha) {
      throw new Error("review-loop: target PR no longer available or missing headSha");
    }

    const installationId = parsedEnv.REVIEW_LOOP_INSTALLATION_ID || target.installationExternalId;
    if (!installationId) {
      throw new Error("review-loop: no installation id available for enqueueing review jobs");
    }

    console.log(`[review-loop] cycle=${cycle} enqueue /review for sha=${pr.headSha}`);
    await enqueueReviewJob({
      provider: "github",
      installationId,
      repoId: target.repo.id,
      pullRequestId: pr.id,
      prNumber: pr.number,
      headSha: pr.headSha,
      trigger: "manual-loop",
      force: true
    });

    const run = await waitForRunCompletion({
      pullRequestId: pr.id,
      headSha: pr.headSha,
      cycleStartedAt,
      pollMs,
      timeoutMs
    });

    const findingsOpenInRun = await prisma.finding.count({
      where: { reviewRunId: run.id, status: "open" }
    });
    const openFindingsInPr = await prisma.finding.count({
      where: { pullRequestId: pr.id, status: "open" }
    });

    const { positive, negative } = await collectFeedback(target.repo.id);

    const repoConfigRow = await prisma.repoConfig.findFirst({ where: { repoId: target.repo.id } });
    const config = structuredClone((repoConfigRow?.configJson || DEFAULT_REPO_CONFIG) as RepoConfig);

    const currentRetrieval = ensureRetrievalConfig(config);
    const tuning = tuneRetrieval({
      current: currentRetrieval,
      positiveFeedback: positive,
      negativeFeedback: negative,
      openFindingsInPr
    });

    if (tuning.tuned) {
      config.retrieval = tuning.next;
      await upsertRepoConfig(target.repo.id, config);
      console.log(`[review-loop] cycle=${cycle} tuned retrieval config: ${JSON.stringify(tuning.next)}`);
    }

    if (cycle % forceIndexEvery === 0) {
      await enqueueIndexJob({
        provider: "github",
        installationId,
        repoId: target.repo.id,
        headSha: pr.headSha,
        force: true
      });
      console.log(`[review-loop] cycle=${cycle} queued forced re-index for sha=${pr.headSha}`);
    }

    const metric: CycleMetrics = {
      cycle,
      startedAt: cycleStartedAt.toISOString(),
      runId: run.id,
      runStatus: run.status,
      durationMs:
        run.startedAt && run.completedAt
          ? run.completedAt.getTime() - run.startedAt.getTime()
          : Date.now() - cycleStartedAt.getTime(),
      findingsOpenInRun,
      openFindingsInPr,
      positiveFeedback: positive,
      negativeFeedback: negative,
      retrieval: tuning.next,
      tuned: tuning.tuned
    };

    await fs.appendFile(outputPath, `${JSON.stringify(metric)}\n`, "utf8");
    console.log(
      `[review-loop] cycle=${cycle} run=${run.id} status=${run.status} openInRun=${findingsOpenInRun} openInPr=${openFindingsInPr} feedback(+/−)=${positive}/${negative}`
    );

    if (cycle < maxCycles) {
      await sleep(pauseMs);
    }
  }

  console.log("[review-loop] completed all cycles");
}

main()
  .catch((err) => {
    console.error("[review-loop] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
