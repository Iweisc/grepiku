import { loadEnv } from "../config/env.js";
import { getProviderAdapter } from "./registry.js";
import { ProviderWebhookEvent } from "./types.js";

const env = loadEnv();

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export async function resolveWebhookEvent(params: {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}): Promise<ProviderWebhookEvent | null> {
  const headers = Object.fromEntries(
    Object.entries(params.headers).map(([k, v]) => [k.toLowerCase(), v])
  );

  if (headerValue(headers, "x-gitlab-event")) {
    const adapter = getProviderAdapter("gitlab");
    return adapter.verifyWebhook({ headers, body: params.body });
  }

  if (headerValue(headers, "x-github-event")) {
    const enterpriseHeader =
      headerValue(headers, "x-github-enterprise-version") ||
      headerValue(headers, "x-github-enterprise-host");
    const providerKind = enterpriseHeader && env.ghesBaseUrl ? "ghes" : "github";
    const adapter = getProviderAdapter(providerKind);
    return adapter.verifyWebhook({ headers, body: params.body });
  }

  return null;
}
