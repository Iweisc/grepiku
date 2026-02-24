import { getProviderAdapter } from "./registry.js";
import { ProviderWebhookEvent } from "./types.js";

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

  if (headerValue(headers, "x-github-event")) {
    const adapter = getProviderAdapter("github");
    return adapter.verifyWebhook({ headers, body: params.body });
  }

  return null;
}
