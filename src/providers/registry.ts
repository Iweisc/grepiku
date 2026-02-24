import { ProviderAdapter, ProviderKind } from "./types.js";
import { createGithubAdapter } from "./github/adapter.js";

const adapters: Record<ProviderKind, ProviderAdapter> = {
  github: createGithubAdapter()
};

export function getProviderAdapter(kind: ProviderKind): ProviderAdapter {
  const adapter = adapters[kind];
  if (!adapter) {
    throw new Error(`Unsupported provider ${kind}`);
  }
  return adapter;
}

export const supportedProviders = Object.keys(adapters) as ProviderKind[];
