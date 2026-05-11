import { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadEnv } from "../config/env.js";
import { resolveRepoConfig, resolveRules } from "../review/triggers.js";
import { retrieveContext } from "../services/retrieval.js";
import { prisma } from "../db/client.js";

const env = loadEnv();
const MAX_INTERNAL_RETRIEVAL_QUERY_CHARS = 2000;

const PositiveIntSchema = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^\d+$/)
  ])
  .transform((value) => Number(value))
  .pipe(z.number().int().positive());
const OptionalTrimmedStringSchema = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .optional()
  .transform((value) => {
    if (value == null) return null;
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  });

const RulesOverrideSchema = z.record(z.unknown()).optional().nullable().default(null);
const TriggerMatcherSchema = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([])
});
const TriggerConfigSchema = z.object({
  manualOnly: z.boolean(),
  allowAutoOnPush: z.boolean(),
  labels: TriggerMatcherSchema,
  branches: TriggerMatcherSchema,
  authors: TriggerMatcherSchema,
  keywords: TriggerMatcherSchema,
  commentTriggers: z.array(z.string())
});
const RetrievalWeightsSchema = z
  .object({
    semanticWeight: z.number().min(0).max(1),
    lexicalWeight: z.number().min(0).max(1),
    rrfWeight: z.number().min(0).max(1),
    changedPathBoost: z.number().min(0).max(1),
    sameDirectoryBoost: z.number().min(0).max(1),
    patternBoost: z.number().min(0).max(1),
    symbolBoost: z.number().min(0).max(1),
    chunkBoost: z.number().min(0).max(1)
  })
  .partial();

const ReviewEnqueueBodySchema = z.object({
  provider: z.literal("github").optional().default("github"),
  installationId: OptionalTrimmedStringSchema,
  repoId: PositiveIntSchema,
  pullRequestId: PositiveIntSchema,
  prNumber: PositiveIntSchema,
  headSha: z.string().trim().min(1),
  trigger: z.string().trim().min(1).optional().default("internal"),
  force: z.boolean().optional().default(false),
  rulesOverride: RulesOverrideSchema
});

const IndexEnqueueBodySchema = z.object({
  provider: z.literal("github").optional().default("github"),
  installationId: OptionalTrimmedStringSchema,
  repoId: PositiveIntSchema,
  headSha: OptionalTrimmedStringSchema,
  patternRepo: z
    .object({
      url: z.string().trim().min(1),
      ref: OptionalTrimmedStringSchema,
      name: OptionalTrimmedStringSchema
    })
    .optional()
    .nullable()
    .default(null),
  force: z.boolean().optional().default(false)
});

const RulesResolveBodySchema = z.object({
  provider: z.literal("github").optional().default("github"),
  repoId: PositiveIntSchema,
  rulesOverride: RulesOverrideSchema
});

const RetrievalBodySchema = z.object({
  repoId: PositiveIntSchema,
  query: z.string().max(MAX_INTERNAL_RETRIEVAL_QUERY_CHARS).optional().default(""),
  topK: PositiveIntSchema.optional(),
  maxPerPath: PositiveIntSchema.optional(),
  changedPaths: z.array(z.string()).optional(),
  weights: RetrievalWeightsSchema.optional()
});

const TriggersUpdateBodySchema = z.object({
  repoId: PositiveIntSchema,
  triggers: TriggerConfigSchema
});

type ParsedBodySchema<T extends z.ZodTypeAny> = z.infer<T>;

function authorize(request: any): boolean {
  if (!env.internalApiKey) return false;
  const header = request.headers["x-internal-key"] || request.headers["authorization"];
  if (!header) return false;
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) return false;
  if (token.startsWith("Bearer ")) {
    return token.slice("Bearer ".length) === env.internalApiKey;
  }
  return token === env.internalApiKey;
}

function parseRequestBody<T extends z.ZodTypeAny>(schema: T, body: unknown, reply: any): ParsedBodySchema<T> | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    return parsed.data;
  }
  reply.code(400).send({ error: "Invalid request body" });
  return null;
}

export function registerInternalApi(app: FastifyInstance) {
  app.post("/internal/review/enqueue", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = parseRequestBody(ReviewEnqueueBodySchema, request.body, reply);
    if (!body) return;
    const { enqueueReviewJob } = await import("../queue/enqueue.js");
    await enqueueReviewJob({
      provider: body.provider,
      installationId: body.installationId,
      repoId: body.repoId,
      pullRequestId: body.pullRequestId,
      prNumber: body.prNumber,
      headSha: body.headSha,
      trigger: body.trigger,
      force: body.force,
      rulesOverride: body.rulesOverride
    });
    reply.send({ ok: true });
  });

  app.post("/internal/index/enqueue", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = parseRequestBody(IndexEnqueueBodySchema, request.body, reply);
    if (!body) return;
    const { enqueueIndexJob } = await import("../queue/enqueue.js");
    await enqueueIndexJob({
      provider: body.provider,
      installationId: body.installationId,
      repoId: body.repoId,
      headSha: body.headSha,
      patternRepo: body.patternRepo,
      force: body.force
    });
    reply.send({ ok: true });
  });

  app.post("/internal/rules/resolve", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = parseRequestBody(RulesResolveBodySchema, request.body, reply);
    if (!body) return;
    const config = await resolveRepoConfig(body.repoId, body.provider);
    const resolved = resolveRules(config, body.rulesOverride);
    reply.send({ ok: true, resolved });
  });

  app.post("/internal/retrieval", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = parseRequestBody(RetrievalBodySchema, request.body, reply);
    if (!body) return;
    const results = await retrieveContext({
      repoId: body.repoId,
      query: body.query,
      topK: body.topK,
      maxPerPath: body.maxPerPath,
      changedPaths: body.changedPaths,
      weights: body.weights
    });
    reply.send({ ok: true, results });
  });

  app.post("/internal/triggers/update", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = parseRequestBody(TriggersUpdateBodySchema, request.body, reply);
    if (!body) return;
    const existing = await prisma.triggerSetting.findFirst({ where: { repoId: body.repoId } });
    if (existing) {
      await prisma.triggerSetting.update({
        where: { id: existing.id },
        data: { configJson: body.triggers }
      });
    } else {
      await prisma.triggerSetting.create({
        data: { repoId: body.repoId, configJson: body.triggers }
      });
    }
    reply.send({ ok: true });
  });
}
