import "dotenv/config";
import Fastify from "fastify";
import { loadEnv } from "./config/env.js";
import { webhooks } from "./github/webhooks.js";

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
  const signature = request.headers["x-hub-signature-256"] as string | undefined;
  const id = request.headers["x-github-delivery"] as string | undefined;
  const name = request.headers["x-github-event"] as string | undefined;
  const payload = (request.body as Buffer).toString("utf8");

  if (!signature || !id || !name) {
    reply.code(400).send({ error: "Missing GitHub headers" });
    return;
  }

  try {
    await webhooks.verifyAndReceive({
      id,
      name: name as any,
      signature,
      payload
    });
    reply.code(200).send({ ok: true });
  } catch (err) {
    request.log.error({ err }, "Webhook verification failed");
    reply.code(401).send({ error: "Invalid signature" });
  }
});

app.get("/healthz", async () => ({ ok: true }));

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err, "Failed to start server");
  process.exit(1);
});
