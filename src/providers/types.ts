export type ProviderKind = "github";

export type ProviderUser = {
  externalId: string;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
};

export type ProviderRepo = {
  externalId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch?: string | null;
  archived?: boolean;
  private?: boolean;
  url?: string | null;
};

export type ProviderPullRequest = {
  externalId: string;
  number: number;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  state: string;
  baseRef?: string | null;
  headRef?: string | null;
  baseSha?: string | null;
  headSha: string;
  draft?: boolean;
  author?: ProviderUser | null;
  labels?: string[];
};

export type ProviderFileChange = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string | null;
};

export type ProviderReviewComment = {
  id: string;
  body: string;
  url?: string | null;
  path?: string | null;
  line?: number | null;
  side?: string | null;
  createdAt?: string | null;
};

export type ProviderStatusCheck = {
  id?: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required";
  detailsUrl?: string | null;
  summary?: string | null;
  text?: string | null;
};

export type ProviderCommit = {
  sha: string;
  message: string;
  authorLogin?: string | null;
};

export type ProviderWebhookEvent =
  | {
      provider: ProviderKind;
      type: "pull_request";
      action: string;
      repo: ProviderRepo;
      pullRequest: ProviderPullRequest;
      installationId?: string | null;
    }
  | {
      provider: ProviderKind;
      type: "comment";
      action: string;
      repo: ProviderRepo;
      pullRequest: ProviderPullRequest;
      comment: ProviderReviewComment;
      author: ProviderUser;
      installationId?: string | null;
    }
  | {
      provider: ProviderKind;
      type: "reaction";
      action: string;
      repo: ProviderRepo;
      pullRequest: ProviderPullRequest;
      comment: ProviderReviewComment;
      author: ProviderUser;
      installationId?: string | null;
    };

export type ProviderClient = {
  provider: ProviderKind;
  repo: ProviderRepo;
  pullRequest: ProviderPullRequest;
  fetchPullRequest: () => Promise<ProviderPullRequest>;
  fetchCommit: (sha: string) => Promise<ProviderCommit>;
  fetchDiffPatch: () => Promise<string>;
  listChangedFiles: () => Promise<ProviderFileChange[]>;
  ensureRepoCheckout: (params: { headSha: string }) => Promise<string>;
  updatePullRequestBody: (body: string) => Promise<void>;
  createSummaryComment: (body: string) => Promise<ProviderReviewComment>;
  updateSummaryComment: (commentId: string, body: string) => Promise<ProviderReviewComment>;
  createInlineComment: (params: {
    path: string;
    line: number;
    side: string;
    body: string;
  }) => Promise<ProviderReviewComment>;
  listInlineComments: () => Promise<ProviderReviewComment[]>;
  updateInlineComment: (commentId: string, body: string) => Promise<ProviderReviewComment>;
  resolveInlineThread?: (commentId: string) => Promise<boolean>;
  createStatusCheck: (check: ProviderStatusCheck) => Promise<ProviderStatusCheck>;
  updateStatusCheck: (checkId: string, check: ProviderStatusCheck) => Promise<ProviderStatusCheck>;
  addReaction?: (commentId: string, reaction: string) => Promise<void>;
  createPullRequest?: (params: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }) => Promise<ProviderPullRequest>;
  findOpenPullRequestByHead?: (params: { head: string; base?: string }) => Promise<ProviderPullRequest | null>;
};

export type ProviderAdapter = {
  kind: ProviderKind;
  verifyWebhook: (params: { headers: Record<string, string | string[] | undefined>; body: string }) => Promise<ProviderWebhookEvent | null>;
  createClient: (params: {
    installationId: string | null;
    repo: ProviderRepo;
    pullRequest: ProviderPullRequest;
  }) => Promise<ProviderClient>;
};
