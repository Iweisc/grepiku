import "dotenv/config";
import Fastify from "fastify";
import { loadEnv } from "./config/env.js";
import { resolveWebhookEvent } from "./providers/webhookRouter.js";
import { handleWebhookEvent } from "./providers/webhookHandler.js";
import { registerInternalApi } from "./server/internal.js";
import { registerDashboard } from "./server/dashboard.js";

const env = loadEnv();

const app = Fastify({
  logger: {
    level: env.logLevel
  }
});

app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
  done(null, body);
});

app.post("/webhooks", async (request, reply) => {
  const payload = (request.body as Buffer).toString("utf8");
  try {
    const event = await resolveWebhookEvent({
      headers: request.headers as Record<string, string | string[] | undefined>,
      body: payload
    });
    if (!event) {
      reply.code(400).send({ error: "Unsupported webhook event" });
      return;
    }
    await handleWebhookEvent(event);
    reply.code(200).send({ ok: true });
  } catch (err) {
    request.log.error({ err }, "Webhook handling failed");
    reply.code(401).send({ error: "Invalid webhook signature" });
  }
});

registerInternalApi(app);
registerDashboard(app);

app.get("/healthz", async () => ({ ok: true }));

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err, "Failed to start server");
  process.exit(1);
});
