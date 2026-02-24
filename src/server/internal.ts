import { FastifyInstance } from "fastify";
import { enqueueIndexJob, enqueueReviewJob } from "../queue/enqueue.js";
import { loadEnv } from "../config/env.js";
import { resolveRepoConfig, resolveRules } from "../review/triggers.js";
import { retrieveContext } from "../services/retrieval.js";
import { prisma } from "../db/client.js";

const env = loadEnv();

function authorize(request: any): boolean {
  if (!env.internalApiKey) return true;
  const header = request.headers["x-internal-key"] || request.headers["authorization"];
  if (!header) return false;
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) return false;
  if (token.startsWith("Bearer ")) {
    return token.slice("Bearer ".length) === env.internalApiKey;
  }
  return token === env.internalApiKey;
}

export function registerInternalApi(app: FastifyInstance) {
  app.post("/internal/review/enqueue", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = request.body as any;
    await enqueueReviewJob({
      provider: body.provider,
      installationId: body.installationId || null,
      repoId: body.repoId,
      pullRequestId: body.pullRequestId,
      prNumber: body.prNumber,
      headSha: body.headSha,
      trigger: body.trigger || "internal",
      force: Boolean(body.force),
      rulesOverride: body.rulesOverride || null
    });
    reply.send({ ok: true });
  });

  app.post("/internal/index/enqueue", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = request.body as any;
    await enqueueIndexJob({
      repoId: body.repoId,
      headSha: body.headSha || null,
      patternRepo: body.patternRepo || null,
      force: Boolean(body.force)
    });
    reply.send({ ok: true });
  });

  app.post("/internal/rules/resolve", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = request.body as any;
    const config = await resolveRepoConfig(body.repoId, body.provider);
    const resolved = resolveRules(config, body.rulesOverride || null);
    reply.send({ ok: true, resolved });
  });

  app.post("/internal/retrieval", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = request.body as any;
    const results = await retrieveContext({
      repoId: body.repoId,
      query: body.query || "",
      topK: body.topK
    });
    reply.send({ ok: true, results });
  });

  app.post("/internal/triggers/update", async (request, reply) => {
    if (!authorize(request)) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = request.body as any;
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
