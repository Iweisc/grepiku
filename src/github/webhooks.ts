import { Webhooks } from "@octokit/webhooks";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

// Legacy compatibility export. Hardened webhook processing now lives in the
// provider adapter, router, and route handler stack, so this helper must not
// register its own queueing side effects.
export const webhooks = new Webhooks({
  secret: env.githubWebhookSecret
});
