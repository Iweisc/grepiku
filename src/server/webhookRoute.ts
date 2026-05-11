import type { FastifyInstance } from "fastify";
import type { ProviderWebhookEvent } from "../providers/types.js";

const WEBHOOK_DELIVERY_PROCESSING_TTL_SEC = 10 * 60;
const WEBHOOK_DELIVERY_HANDLED_TTL_SEC = 7 * 24 * 60 * 60;

function webhookDeliveryRedisKey(deliveryId: string): string {
  return `webhook:delivery:${deliveryId}`;
}

async function getWebhookDeliveryRedisClient() {
  const { redisClient } = await import("../queue/index.js");
  return redisClient;
}

async function claimWebhookDelivery(deliveryId: string): Promise<boolean> {
  const redisClient = await getWebhookDeliveryRedisClient();
  const claimed = await redisClient.set(
    webhookDeliveryRedisKey(deliveryId),
    "processing",
    "EX",
    WEBHOOK_DELIVERY_PROCESSING_TTL_SEC,
    "NX"
  );
  return claimed === "OK";
}

async function completeWebhookDelivery(deliveryId: string): Promise<void> {
  const redisClient = await getWebhookDeliveryRedisClient();
  await redisClient.set(
    webhookDeliveryRedisKey(deliveryId),
    "handled",
    "EX",
    WEBHOOK_DELIVERY_HANDLED_TTL_SEC
  );
}

async function releaseWebhookDelivery(deliveryId: string): Promise<void> {
  const redisClient = await getWebhookDeliveryRedisClient();
  await redisClient.del(webhookDeliveryRedisKey(deliveryId));
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

type WebhookResolver = (params: {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}) => Promise<ProviderWebhookEvent | null>;

type WebhookHandler = (event: ProviderWebhookEvent) => Promise<void>;

export function registerWebhookRoute(
  app: FastifyInstance,
  deps: {
    resolveWebhookEvent: WebhookResolver;
    handleWebhookEvent: WebhookHandler;
    claimWebhookDelivery?: (deliveryId: string) => Promise<boolean>;
    completeWebhookDelivery?: (deliveryId: string) => Promise<void>;
    releaseWebhookDelivery?: (deliveryId: string) => Promise<void>;
  }
) {
  app.post("/webhooks", async (request, reply) => {
    const payload = (request.body as Buffer).toString("utf8");
    let event: ProviderWebhookEvent | null;
    try {
      event = await deps.resolveWebhookEvent({
        headers: request.headers as Record<string, string | string[] | undefined>,
        body: payload
      });
    } catch (err) {
      request.log.error({ err }, "Webhook handling failed");
      reply.code(401).send({ error: "Invalid webhook signature" });
      return;
    }

    if (!event) {
      reply.code(202).send({ ok: true, ignored: true });
      return;
    }

    const deliveryId = firstHeaderValue(request.headers["x-github-delivery"]);
    const signature = firstHeaderValue(request.headers["x-hub-signature-256"]);
    const deliveryClaimKey = signature || deliveryId;
    const claimDelivery = deps.claimWebhookDelivery || claimWebhookDelivery;
    const finishDelivery = deps.completeWebhookDelivery || completeWebhookDelivery;
    const releaseDelivery = deps.releaseWebhookDelivery || releaseWebhookDelivery;
    let claimedDelivery = false;

    if (deliveryClaimKey) {
      try {
        claimedDelivery = await claimDelivery(deliveryClaimKey);
      } catch (err) {
        request.log.error({ err, deliveryId }, "Webhook delivery claim failed");
        reply.code(503).send({ error: "Webhook replay guard unavailable" });
        return;
      }
      if (!claimedDelivery) {
        reply.code(202).send({ ok: true, ignored: true, duplicate: true });
        return;
      }
    }

    try {
      await deps.handleWebhookEvent(event);
      if (deliveryClaimKey && claimedDelivery) {
        await finishDelivery(deliveryClaimKey).catch((err) => {
          request.log.warn({ err, deliveryId }, "Webhook delivery completion mark failed");
        });
      }
      reply.code(200).send({ ok: true });
    } catch (err) {
      if (deliveryClaimKey && claimedDelivery) {
        await releaseDelivery(deliveryClaimKey).catch((releaseErr) => {
          request.log.warn({ err: releaseErr, deliveryId }, "Webhook delivery release failed");
        });
      }
      request.log.error({ err }, "Webhook event processing failed");
      reply.code(500).send({ error: "Webhook handling failed" });
    }
  });
}
