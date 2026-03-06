import { prisma } from "../db/client.js";
import { enqueueIndexJob } from "../queue/enqueue.js";
import { redisClient } from "../queue/index.js";

type Options = {
  dryRun: boolean;
  includeArchived: boolean;
  enqueueReindex: boolean;
  resetVectors: boolean;
  deleteQueryEmbeddings: boolean;
  limit: number | null;
  repoIds: number[];
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dryRun: false,
    includeArchived: false,
    enqueueReindex: true,
    resetVectors: true,
    deleteQueryEmbeddings: true,
    limit: null,
    repoIds: []
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--include-archived") {
      opts.includeArchived = true;
      continue;
    }
    if (arg === "--no-enqueue-reindex") {
      opts.enqueueReindex = false;
      continue;
    }
    if (arg === "--no-reset-vectors") {
      opts.resetVectors = false;
      continue;
    }
    if (arg === "--no-delete-query-embeddings") {
      opts.deleteQueryEmbeddings = false;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isFinite(value) && value > 0) {
        opts.limit = Math.floor(value);
      }
      continue;
    }
    if (arg.startsWith("--repo-id=")) {
      const value = Number(arg.slice("--repo-id=".length));
      if (Number.isFinite(value) && value > 0) {
        opts.repoIds.push(Math.floor(value));
      }
      continue;
    }
  }

  opts.repoIds = Array.from(new Set(opts.repoIds));
  return opts;
}

async function enqueueRepoReindex(params: {
  repoId: number;
  provider: "github";
  installationId: string | null;
  headSha: string | null;
  patternRepos: Array<{ url: string; ref?: string | null; name: string }>;
  dryRun: boolean;
}) {
  let jobs = 0;
  if (!params.dryRun) {
    await enqueueIndexJob({
      provider: params.provider,
      installationId: params.installationId,
      repoId: params.repoId,
      headSha: params.headSha,
      force: true
    });
  }
  jobs += 1;

  for (const pattern of params.patternRepos) {
    if (!params.dryRun) {
      await enqueueIndexJob({
        provider: params.provider,
        installationId: params.installationId,
        repoId: params.repoId,
        headSha: params.headSha,
        force: true,
        patternRepo: {
          url: pattern.url,
          ref: pattern.ref || undefined,
          name: pattern.name
        }
      });
    }
    jobs += 1;
  }
  return jobs;
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  const repoWhere: Record<string, unknown> = {};
  if (!opts.includeArchived) repoWhere.archived = false;
  if (opts.repoIds.length > 0) repoWhere.id = { in: opts.repoIds };

  const repos = await prisma.repo.findMany({
    where: repoWhere,
    include: {
      provider: { select: { kind: true } },
      installations: { include: { installation: true } },
      patternLinks: { include: { patternRepo: true } }
    },
    orderBy: { id: "asc" },
    take: opts.limit || undefined
  });

  let reindexJobs = 0;
  const targetRepoIds: number[] = [];

  for (const repo of repos) {
    if (repo.provider.kind !== "github") continue;
    targetRepoIds.push(repo.id);

    const latestPr = await prisma.pullRequest.findFirst({
      where: { repoId: repo.id },
      orderBy: { updatedAt: "desc" },
      select: { headSha: true }
    });
    const installationId = repo.installations[0]?.installation.externalId || null;
    const patternRepos = repo.patternLinks.map((link) => ({
      url: link.patternRepo.url,
      ref: link.patternRepo.ref,
      name: link.patternRepo.name
    }));

    const jobs = await enqueueRepoReindex({
      repoId: repo.id,
      provider: "github",
      installationId,
      headSha: latestPr?.headSha || null,
      patternRepos,
      dryRun: opts.dryRun || !opts.enqueueReindex
    });
    reindexJobs += jobs;
  }

  const uniqueTargetRepoIds = Array.from(new Set(targetRepoIds));
  const embeddingWhere: Record<string, unknown> = {
    repoId: uniqueTargetRepoIds.length > 0 ? { in: uniqueTargetRepoIds } : { in: [-1] }
  };
  const vectorWhere: Record<string, unknown> = {
    ...embeddingWhere,
    kind: { in: ["file", "symbol", "chunk"] }
  };
  const queryWhere: Record<string, unknown> = {
    ...embeddingWhere,
    kind: "query"
  };

  const vectorCount = opts.resetVectors
    ? await prisma.embedding.count({ where: vectorWhere as any })
    : 0;
  const queryCount = opts.deleteQueryEmbeddings
    ? await prisma.embedding.count({ where: queryWhere as any })
    : 0;

  let vectorsReset = 0;
  let queriesDeleted = 0;

  if (!opts.dryRun) {
    if (opts.resetVectors) {
      const result = await prisma.embedding.updateMany({
        where: vectorWhere as any,
        data: { vector: [] }
      });
      vectorsReset = result.count;
    }
    if (opts.deleteQueryEmbeddings) {
      const result = await prisma.embedding.deleteMany({
        where: queryWhere as any
      });
      queriesDeleted = result.count;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: opts.dryRun ? "dry-run" : "apply",
        reposSelected: uniqueTargetRepoIds.length,
        reindexJobsPlanned: opts.enqueueReindex ? reindexJobs : 0,
        vectorRowsTargeted: vectorCount,
        queryRowsTargeted: queryCount,
        vectorRowsUpdated: opts.dryRun ? 0 : vectorsReset,
        queryRowsDeleted: opts.dryRun ? 0 : queriesDeleted
      },
      null,
      2
    )
  );
}

run()
  .catch((err) => {
    console.error("[migrate-pageindex] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await redisClient.quit().catch(() => undefined);
  });
