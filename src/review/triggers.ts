import { minimatch } from "minimatch";
import { RepoConfig, RuleConfig, resolveRepoConfig as loadCachedConfig } from "./config.js";
import { ProviderPullRequest } from "../providers/types.js";

export type RulesOverride = {
  orgDefaults?: Partial<RepoConfig>;
  uiRules?: RuleConfig[];
  strictness?: RepoConfig["strictness"];
  commentTypes?: RepoConfig["commentTypes"];
  output?: RepoConfig["output"];
  retrieval?: RepoConfig["retrieval"];
  triggers?: RepoConfig["triggers"];
};

export function resolveRules(config: RepoConfig, overrides?: RulesOverride | null) {
  const orgDefaults = overrides?.orgDefaults;
  const merged: RepoConfig = {
    ...orgDefaults,
    ...config,
    rules: [
      ...(orgDefaults?.rules || []),
      ...(config.rules || []),
      ...(overrides?.uiRules || [])
    ],
    scopes: [...(orgDefaults?.scopes || []), ...(config.scopes || [])],
    patternRepositories: [
      ...(orgDefaults?.patternRepositories || []),
      ...(config.patternRepositories || [])
    ],
    strictness: overrides?.strictness || config.strictness,
    commentTypes: overrides?.commentTypes || config.commentTypes,
    output: overrides?.output || config.output,
    retrieval: overrides?.retrieval || config.retrieval,
    triggers: overrides?.triggers || config.triggers
  };
  return merged;
}

export async function resolveRepoConfig(repoId: number, providerKind?: string) {
  return loadCachedConfig(repoId, providerKind);
}

function matchesAny(value: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => minimatch(value, pattern, { nocase: true }));
}

function containsAny(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

export type CommentTrigger = "review" | "mention";

export function detectCommentTrigger(text: string, config: RepoConfig): CommentTrigger | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const tokens = config.triggers.commentTriggers || [];
  const reviewTokens = tokens.filter((token) => token.trim().startsWith("/"));
  const mentionTokens = tokens.filter((token) => !token.trim().startsWith("/"));

  if (reviewTokens.some((token) => lower.includes(token.toLowerCase()))) {
    return "review";
  }
  if (mentionTokens.some((token) => lower.includes(token.toLowerCase()))) {
    return "mention";
  }
  return null;
}

export function shouldTriggerReview(params: {
  trigger: string;
  config: RepoConfig;
  pullRequest: ProviderPullRequest;
}): boolean {
  const { trigger, config, pullRequest } = params;

  if (config.triggers.manualOnly && trigger !== "manual" && trigger !== "comment") {
    return false;
  }

  if (!config.triggers.allowAutoOnPush && ["synchronize", "push"].includes(trigger)) {
    return false;
  }

  const labels = pullRequest.labels || [];
  if (config.triggers.labels.include.length > 0) {
    const matches = labels.some((label) =>
      matchesAny(label, config.triggers.labels.include)
    );
    if (!matches) return false;
  }
  if (config.triggers.labels.exclude.length > 0) {
    const excluded = labels.some((label) =>
      matchesAny(label, config.triggers.labels.exclude)
    );
    if (excluded) return false;
  }

  const baseRef = pullRequest.baseRef || "";
  if (config.triggers.branches.include.length > 0 && !matchesAny(baseRef, config.triggers.branches.include)) {
    return false;
  }
  if (config.triggers.branches.exclude.length > 0 && matchesAny(baseRef, config.triggers.branches.exclude)) {
    return false;
  }

  const author = pullRequest.author?.login || "";
  if (config.triggers.authors.include.length > 0 && !matchesAny(author, config.triggers.authors.include)) {
    return false;
  }
  if (config.triggers.authors.exclude.length > 0 && matchesAny(author, config.triggers.authors.exclude)) {
    return false;
  }

  const text = `${pullRequest.title || ""}\n${pullRequest.body || ""}`;
  if (config.triggers.keywords.include.length > 0 && !containsAny(text, config.triggers.keywords.include)) {
    return false;
  }
  if (config.triggers.keywords.exclude.length > 0 && containsAny(text, config.triggers.keywords.exclude)) {
    return false;
  }

  return true;
}
