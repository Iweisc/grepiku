import type { ProviderPullRequest } from "../providers/types.js";

export type StoredPullRequestState = {
  title: string | null;
  body: string | null;
  url: string | null;
  state: string;
  baseRef: string | null;
  headRef: string | null;
  baseSha: string | null;
  headSha: string;
  draft: boolean;
};

function preferDefined<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function mergeStoredPullRequestState(
  stored: StoredPullRequestState,
  refreshed: ProviderPullRequest
): StoredPullRequestState {
  return {
    title: preferDefined(refreshed.title, stored.title),
    body: preferDefined(refreshed.body, stored.body),
    url: preferDefined(refreshed.url, stored.url),
    state: refreshed.state,
    baseRef: preferDefined(refreshed.baseRef, stored.baseRef),
    headRef: preferDefined(refreshed.headRef, stored.headRef),
    baseSha: preferDefined(refreshed.baseSha, stored.baseSha),
    headSha: refreshed.headSha || stored.headSha,
    draft: refreshed.draft ?? stored.draft
  };
}
