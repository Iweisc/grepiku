import "dotenv/config";
import Fastify from "fastify";
import { loadEnv } from "./config/env.js";
import { resolveWebhookEvent } from "./providers/webhookRouter.js";
import { handleWebhookEvent } from "./providers/webhookHandler.js";
import { registerInternalApi } from "./server/internal.js";
import { registerDashboard } from "./server/dashboard.js";
import { registerWebhookRoute } from "./server/webhookRoute.js";

const env = loadEnv();

export function buildApp() {
  const app = Fastify({
    logger: {
      level: env.logLevel
    }
  });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    if (req.url === "/webhooks") {
      done(null, body);
      return;
    }
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  registerWebhookRoute(app, {
    resolveWebhookEvent,
    handleWebhookEvent
  });

  registerInternalApi(app);
  registerDashboard(app);

  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

const isEntryPoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js");

if (isEntryPoint) {
  const app = buildApp();
  app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err, "Failed to start server");
    process.exit(1);
  });
}
