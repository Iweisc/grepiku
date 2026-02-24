import { loadEnv } from "../config/env.js";
import { ProviderAdapter, ProviderKind } from "./types.js";
import { createGithubAdapter } from "./github/adapter.js";
import { gitlabAdapter } from "./gitlab/adapter.js";

const env = loadEnv();

const adapters: Record<ProviderKind, ProviderAdapter> = {
  github: createGithubAdapter("github"),
  ghes: createGithubAdapter("ghes", env.ghesBaseUrl || undefined),
  gitlab: gitlabAdapter
};

export function getProviderAdapter(kind: ProviderKind): ProviderAdapter {
  const adapter = adapters[kind];
  if (!adapter) {
    throw new Error(`Unsupported provider ${kind}`);
  }
  return adapter;
}

export const supportedProviders = Object.keys(adapters) as ProviderKind[];
