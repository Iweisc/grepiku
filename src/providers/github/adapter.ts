import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import { loadEnv } from "../../config/env.js";
import { getInstallationOctokit, getInstallationToken, getAppSlug } from "../../github/auth.js";
import { execaAuthenticatedGit } from "../../github/gitAuth.js";
import {
  ProviderAdapter,
  ProviderClient,
  ProviderFileChange,
  ProviderRepo,
  ProviderPullRequest,
  ProviderReviewComment,
  ProviderStatusCheck,
  ProviderWebhookEvent
} from "../types.js";
import { ensureGitRepoCheckout } from "../repoCheckout.js";

const env = loadEnv();
const DEFAULT_MAX_CHANGED_FILES = 1500;
const DEFAULT_MAX_CHANGED_FILE_BYTES = 512_000;
const DEFAULT_MAX_INLINE_COMMENTS = 500;
const DEFAULT_MAX_INLINE_COMMENT_BYTES = 512_000;
const DEFAULT_MAX_REVIEW_THREAD_COMMENT_IDS = 5_000;
const DEFAULT_MAX_PROVIDER_DIFF_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PROVIDER_ERROR_BYTES = 64 * 1024;

type DiffTooLargeLikeError = Error & {
  status?: number;
  response?: {
    data?: {
      message?: string;
      errors?: Array<{ field?: string; code?: string }>;
    };
  };
};

type GithubErrorResponseData = NonNullable<
  NonNullable<DiffTooLargeLikeError["response"]>["data"]
>;

function verifySignature(secret: string, payload: string, signature?: string): boolean {
  if (!secret || !signature) return false;
  const hmac = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  const expected = `sha256=${hmac}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPullRequestWebhookPayload(payload: any): boolean {
  return isRecord(payload?.pull_request) && !isRecord(payload?.comment) && !isRecord(payload?.reaction);
}

function isIssueCommentWebhookPayload(payload: any): boolean {
  return (
    isRecord(payload?.issue) &&
    isRecord(payload.issue?.pull_request) &&
    isRecord(payload?.comment) &&
    !isRecord(payload?.reaction)
  );
}

function isPullRequestReviewCommentWebhookPayload(payload: any): boolean {
  const comment = payload?.comment || payload?.review_comment;
  return (
    isRecord(payload?.pull_request) &&
    isRecord(comment) &&
    !isRecord(payload?.reaction) &&
    (typeof comment.path === "string" ||
      typeof comment.commit_id === "string" ||
      typeof comment.pull_request_review_id === "number" ||
      typeof comment.in_reply_to_id === "number")
  );
}

function isReactionWebhookPayload(payload: any): boolean {
  const comment = payload?.comment || payload?.review_comment;
  return (
    isRecord(payload?.reaction) &&
    isRecord(payload?.sender) &&
    (isRecord(comment) || isRecord(payload?.issue) || isRecord(payload?.pull_request))
  );
}

function mapRepo(payload: any): ProviderRepo {
  return {
    externalId: String(payload.repository?.id ?? payload.repository?.node_id ?? ""),
    owner: payload.repository?.owner?.login || payload.repository?.owner?.name || "",
    name: payload.repository?.name || "",
    fullName: payload.repository?.full_name || "",
    defaultBranch: payload.repository?.default_branch || null,
    archived: Boolean(payload.repository?.archived),
    private: Boolean(payload.repository?.private),
    url: payload.repository?.html_url || null
  };
}

function mapPullRequest(payload: any): ProviderPullRequest {
  const pr = payload.pull_request || payload.merge_request || {};
  return {
    externalId: String(pr.id ?? payload.issue?.id ?? ""),
    number: Number(pr.number ?? payload.issue?.number ?? 0),
    title: pr.title ?? payload.issue?.title ?? null,
    body: pr.body ?? payload.issue?.body ?? null,
    url: pr.html_url ?? payload.issue?.html_url ?? null,
    state: pr.state ?? payload.issue?.state ?? "open",
    baseRef: pr.base?.ref ?? null,
    headRef: pr.head?.ref ?? null,
    headRepoFullName: pr.head?.repo?.full_name ?? null,
    baseSha: pr.base?.sha ?? null,
    headSha: pr.head?.sha ?? "",
    draft: Boolean(pr.draft),
    author: pr.user
      ? {
          externalId: String(pr.user.id ?? ""),
          login: pr.user.login || "",
          name: pr.user.name ?? null,
          avatarUrl: pr.user.avatar_url ?? null
        }
      : null,
    labels: Array.isArray(pr.labels) ? pr.labels.map((label: any) => label?.name).filter(Boolean) : []
  };
}

function mapComment(payload: any): ProviderReviewComment {
  const comment = payload.comment || payload.review_comment || {};
  return {
    id: String(comment.id ?? ""),
    body: comment.body || "",
    url: comment.html_url || null,
    path: comment.path || null,
    line: comment.line ?? null,
    side: comment.side || null,
    inReplyToId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null,
    createdAt: comment.created_at || null
  };
}

function mapAuthor(payload: any) {
  const user = payload.comment?.user || payload.sender || {};
  return {
    externalId: String(user.id ?? ""),
    login: user.login || "",
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
    association: payload.comment?.author_association ?? payload.review_comment?.author_association ?? null
  };
}

function mapSenderAuthor(payload: any) {
  const user = payload.sender || {};
  return {
    externalId: String(user.id ?? ""),
    login: user.login || "",
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
    association:
      typeof payload.sender?.author_association === "string"
        ? payload.sender.author_association
        : null
  };
}

function isPullRequestReactionPayload(payload: any): boolean {
  if (payload.issue?.pull_request) return true;
  if (payload.pull_request) return true;
  const comment = payload.comment || payload.review_comment || {};
  return Boolean(comment.pull_request_review_id || comment.path || comment.commit_id || comment.in_reply_to_id);
}

function normalizePostedBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\+n/g, "\n")
    .replace(/(^|[\s:;,.!?])\/n(?=\s*(?:\d+\.|[-*]|$))/gm, "$1\n")
    .trim();
}

function normalizeGithubChangedFile(file: any): ProviderFileChange | null {
  const path = typeof file?.filename === "string" ? file.filename.trim() : "";
  if (!path) return null;
  const additions =
    typeof file?.additions === "number" && Number.isFinite(file.additions)
      ? file.additions
      : undefined;
  const deletions =
    typeof file?.deletions === "number" && Number.isFinite(file.deletions)
      ? file.deletions
      : undefined;
  return {
    path,
    status: typeof file?.status === "string" ? file.status : undefined,
    additions,
    deletions
  };
}

function normalizeGithubReviewComment(comment: any): ProviderReviewComment | null {
  const id = comment?.id;
  if (id == null) return null;
  const authorLogin =
    typeof comment?.user?.login === "string" && comment.user.login.trim().length > 0
      ? comment.user.login
      : null;
  return {
    id: String(id),
    body: comment?.body || "",
    url: comment?.html_url || null,
    path: comment?.path || null,
    line: comment?.line || null,
    side: comment?.side || null,
    createdAt: comment?.created_at || null,
    ...(authorLogin ? { authorLogin } : {})
  };
}

function normalizeBotAwareLogin(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\[bot\]$/i, "");
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function buildGithubDiffTooLargeError(maxBytes: number): DiffTooLargeLikeError {
  const message = `provider diff exceeded safe byte limit (${maxBytes} bytes)`;
  const error = new Error(message) as DiffTooLargeLikeError;
  error.status = 406;
  error.response = {
    data: {
      message,
      errors: [{ field: "diff", code: "too_large" }]
    }
  };
  return error;
}

function buildGithubHttpError(status: number, responseText: string): DiffTooLargeLikeError {
  let message = `GitHub API error ${status}`;
  let data: GithubErrorResponseData | undefined;

  const trimmed = responseText.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as GithubErrorResponseData;
      if (parsed && typeof parsed === "object") {
        data = parsed;
        if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
          message = parsed.message.trim();
        }
      }
    } catch {
      message = trimmed;
    }
  }

  const error = new Error(message) as DiffTooLargeLikeError;
  error.status = status;
  if (data) {
    error.response = { data };
  }
  return error;
}

async function readResponseTextWithinLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw buildGithubDiffTooLargeError(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function readErrorResponseText(response: Response): Promise<string> {
  try {
    return await readResponseTextWithinLimit(response, DEFAULT_MAX_PROVIDER_ERROR_BYTES);
  } catch (error) {
    if ((error as DiffTooLargeLikeError | undefined)?.status === 406) {
      return "";
    }
    throw error;
  }
}

async function fetchGithubPullRequestDiffWithinLimit(params: {
  url: string;
  token: string;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = params.fetchImpl || fetch;
  const maxBytes = normalizePositiveInt(params.maxBytes, DEFAULT_MAX_PROVIDER_DIFF_BYTES);
  const headers = new Headers();
  headers.set("accept", "application/vnd.github.v3.diff");
  headers.set("authorization", `Bearer ${params.token}`);
  headers.set("user-agent", "grepiku");

  const response = await fetchImpl(params.url, {
    method: "GET",
    headers
  });

  if (!response.ok) {
    const responseText = await readErrorResponseText(response);
    throw buildGithubHttpError(response.status, responseText);
  }

  return readResponseTextWithinLimit(response, maxBytes);
}

async function listGithubPullRequestFiles(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<ProviderFileChange[]> {
  const maxFiles = normalizePositiveInt(params.maxFiles, DEFAULT_MAX_CHANGED_FILES);
  const maxBytes = normalizePositiveInt(params.maxBytes, DEFAULT_MAX_CHANGED_FILE_BYTES);
  const files: ProviderFileChange[] = [];
  let retainedBytes = 2;

  for await (const page of params.octokit.paginate.iterator(params.octokit.pulls.listFiles, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100
  })) {
    const pageData = Array.isArray(page?.data) ? page.data : [];
    for (const file of pageData) {
      if (files.length >= maxFiles || retainedBytes >= maxBytes) {
        return files;
      }
      const normalized = normalizeGithubChangedFile(file);
      if (!normalized) continue;
      const serialized = JSON.stringify(normalized);
      const entryBytes = Buffer.byteLength(serialized, "utf8");
      const separatorBytes = files.length > 0 ? 1 : 0;
      if (retainedBytes + separatorBytes + entryBytes > maxBytes) {
        return files;
      }
      files.push(normalized);
      retainedBytes += separatorBytes + entryBytes;
    }
  }

  return files;
}

async function listGithubReviewComments(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  bodyIncludes?: string;
  authorLogin?: string;
  maxComments?: number;
  maxBytes?: number;
}): Promise<ProviderReviewComment[]> {
  const maxComments = normalizePositiveInt(params.maxComments, DEFAULT_MAX_INLINE_COMMENTS);
  const maxBytes = normalizePositiveInt(params.maxBytes, DEFAULT_MAX_INLINE_COMMENT_BYTES);
  const bodyIncludes =
    typeof params.bodyIncludes === "string" && params.bodyIncludes.length > 0
      ? params.bodyIncludes
      : null;
  const authorLogin = normalizeBotAwareLogin(params.authorLogin);
  const comments: ProviderReviewComment[] = [];
  let retainedBytes = 2;

  for await (const page of params.octokit.paginate.iterator(
    params.octokit.pulls.listReviewComments,
    {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      per_page: 100
    }
  )) {
    const pageData = Array.isArray(page?.data) ? page.data : [];
    for (const comment of pageData) {
      if (comments.length >= maxComments || retainedBytes >= maxBytes) {
        return comments;
      }
      if (
        authorLogin &&
        normalizeBotAwareLogin(
          typeof comment?.user?.login === "string" ? comment.user.login : null
        ) !== authorLogin
      ) {
        continue;
      }
      const normalized = normalizeGithubReviewComment(comment);
      if (!normalized) continue;
      if (bodyIncludes && !normalized.body.includes(bodyIncludes)) {
        continue;
      }
      const serialized = JSON.stringify(normalized);
      const entryBytes = Buffer.byteLength(serialized, "utf8");
      const separatorBytes = comments.length > 0 ? 1 : 0;
      if (retainedBytes + separatorBytes + entryBytes > maxBytes) {
        return comments;
      }
      comments.push(normalized);
      retainedBytes += separatorBytes + entryBytes;
    }
  }

  return comments;
}

type ReviewThreadLookup = { threadId: string; isResolved: boolean };

type ThreadCommentsConnection = {
  nodes?: Array<{ databaseId?: number | null } | null> | null;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
};

type GraphqlThreadPage = {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: Array<{
          id?: string | null;
          isResolved?: boolean | null;
          comments?: ThreadCommentsConnection | null;
        } | null> | null;
        pageInfo?: {
          hasNextPage?: boolean;
          endCursor?: string | null;
        } | null;
      } | null;
    } | null;
  } | null;
};

type ThreadCommentsPage = {
  node?: {
    comments?: ThreadCommentsConnection | null;
  } | null;
};

type GraphqlRequest = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

function appendCommentIds(
  comments: ThreadCommentsConnection | null | undefined,
  threadId: string,
  isResolved: boolean,
  result: Map<string, ReviewThreadLookup>,
  maxCommentIds: number
): boolean {
  for (const comment of comments?.nodes || []) {
    if (result.size >= maxCommentIds) {
      return true;
    }
    const databaseId = comment?.databaseId;
    if (databaseId) {
      result.set(String(databaseId), { threadId, isResolved });
    }
  }
  return result.size >= maxCommentIds;
}

async function appendThreadComments(params: {
  graphql: GraphqlRequest;
  threadId: string;
  isResolved: boolean;
  commentsAfter: string;
  result: Map<string, ReviewThreadLookup>;
  maxCommentIds: number;
}) {
  const commentsQuery = `
    query($threadId: ID!, $commentsAfter: String) {
      node(id: $threadId) {
        ... on PullRequestReviewThread {
          comments(first: 100, after: $commentsAfter) {
            nodes { databaseId }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;

  let commentsAfter: string | null = params.commentsAfter;
  while (commentsAfter && params.result.size < params.maxCommentIds) {
    const page = (await params.graphql(commentsQuery, {
      threadId: params.threadId,
      commentsAfter
    })) as ThreadCommentsPage;
    const comments = page.node?.comments;
    const limitReached = appendCommentIds(
      comments,
      params.threadId,
      params.isResolved,
      params.result,
      params.maxCommentIds
    );
    if (limitReached) {
      break;
    }
    if (!comments?.pageInfo?.hasNextPage || !comments.pageInfo.endCursor) break;
    commentsAfter = comments.pageInfo.endCursor;
  }
}

export async function loadGithubReviewThreadMap(params: {
  graphql: GraphqlRequest;
  owner: string;
  repo: string;
  pullNumber: number;
  maxCommentIds?: number;
}): Promise<Map<string, ReviewThreadLookup>> {
  const result = new Map<string, ReviewThreadLookup>();
  let after: string | null = null;
  const maxCommentIds = normalizePositiveInt(
    params.maxCommentIds,
    DEFAULT_MAX_REVIEW_THREAD_COMMENT_IDS
  );

  const query = `
    query($owner: String!, $repo: String!, $pullNumber: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pullNumber) {
          reviewThreads(first: 100, after: $after) {
            nodes {
              id
              isResolved
              comments(first: 100) {
                nodes {
                  databaseId
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  while (result.size < maxCommentIds) {
    const page = (await params.graphql(query, {
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      after
    })) as GraphqlThreadPage;
    const threads = page.repository?.pullRequest?.reviewThreads;
    for (const thread of threads?.nodes || []) {
      if (result.size >= maxCommentIds) break;
      const threadId = thread?.id;
      if (!threadId) continue;
      const isResolved = Boolean(thread.isResolved);
      const comments = thread.comments;
      const limitReached = appendCommentIds(
        comments,
        threadId,
        isResolved,
        result,
        maxCommentIds
      );
      if (limitReached) {
        break;
      }
      if (comments?.pageInfo?.hasNextPage && comments.pageInfo.endCursor) {
        await appendThreadComments({
          graphql: params.graphql,
          threadId,
          isResolved,
          commentsAfter: comments.pageInfo.endCursor,
          result,
          maxCommentIds
        });
      }
    }

    if (result.size >= maxCommentIds) {
      break;
    }
    if (!threads?.pageInfo?.hasNextPage || !threads.pageInfo.endCursor) break;
    after = threads.pageInfo.endCursor;
  }

  return result;
}

function isIntegrationPermissionDenied(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message} ${(error as { stack?: string }).stack || ""}`
      : String(error || "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("resource not accessible by integration") ||
    normalized.includes("requested url returned error: 403") ||
    normalized.includes("http 403")
  );
}

function createClient(params: {
  installationId: string | null;
  repo: ProviderRepo;
  pullRequest: ProviderPullRequest;
}): ProviderClient {
  const installationId = params.installationId ? Number(params.installationId) : null;
  if (!installationId) {
    throw new Error("GitHub installationId required for provider client");
  }
  const octokit = getInstallationOctokit(installationId);
  const owner = params.repo.owner;
  const repo = params.repo.name;
  const prNumber = params.pullRequest.number;
  const headSha = params.pullRequest.headSha;
  let reviewThreadMapCache: Map<string, { threadId: string; isResolved: boolean }> | null = null;
  let canResolveThreads = true;

  async function loadReviewThreadMap(): Promise<Map<string, { threadId: string; isResolved: boolean }>> {
    if (reviewThreadMapCache) return reviewThreadMapCache;
    reviewThreadMapCache = await loadGithubReviewThreadMap({
      graphql: (query, variables) => (octokit as any).graphql(query, variables),
      owner,
      repo,
      pullNumber: prNumber
    });
    return reviewThreadMapCache;
  }

  async function resolveInlineThread(commentId: string): Promise<boolean> {
    if (!canResolveThreads) return false;
    const lookup = await loadReviewThreadMap();
    const entry = lookup.get(String(commentId));
    if (!entry) return false;
    if (entry.isResolved) return true;
    const mutation = `
      mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread {
            id
            isResolved
          }
        }
      }
    `;
    try {
      await (octokit as any).graphql(mutation, { threadId: entry.threadId });
    } catch (error) {
      if (isIntegrationPermissionDenied(error)) {
        canResolveThreads = false;
        return false;
      }
      throw error;
    }
    entry.isResolved = true;
    return true;
  }

  return {
    provider: "github",
    repo: params.repo,
    pullRequest: params.pullRequest,
    fetchPullRequest: async () => {
      const response = await octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      });
      return mapPullRequest({ pull_request: response.data });
    },
    fetchCommit: async (sha: string) => {
      const response = await octokit.repos.getCommit({
        owner,
        repo,
        ref: sha
      });
      return {
        sha: response.data.sha,
        message: response.data.commit?.message || "",
        authorLogin: response.data.author?.login || null,
        parentCount: response.data.parents?.length ?? undefined
      };
    },
    fetchDiffPatch: async () => {
      const token = await getInstallationToken(installationId);
      return fetchGithubPullRequestDiffWithinLimit({
        url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
        token
      });
    },
    listChangedFiles: async () =>
      listGithubPullRequestFiles({
        octokit,
        owner,
        repo,
        pullNumber: prNumber
      }),
    ensureRepoCheckout: async ({ headSha }) => {
      const token = await getInstallationToken(installationId);
      return ensureGitRepoCheckout({
        headSha,
        owner,
        repo,
        token,
        pullRequestNumber: prNumber
      });
    },
    updatePullRequestBody: async (body: string) => {
      await octokit.pulls.update({ owner, repo, pull_number: prNumber, body });
    },
    createSummaryComment: async (body: string) => {
      const normalizedBody = normalizePostedBody(body);
      const created = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: normalizedBody
      });
      return {
        id: String(created.data.id),
        body: created.data.body || normalizedBody,
        url: created.data.html_url || null
      };
    },
    updateSummaryComment: async (commentId: string, body: string) => {
      const normalizedBody = normalizePostedBody(body);
      const updated = await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: Number(commentId),
        body: normalizedBody
      });
      return {
        id: String(updated.data.id),
        body: updated.data.body || normalizedBody,
        url: updated.data.html_url || null
      };
    },
    createInlineComment: async ({ path, line, side, body }) => {
      const normalizedBody = normalizePostedBody(body);
      const created = await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        body: normalizedBody,
        path,
        line,
        side: side === "LEFT" ? "LEFT" : "RIGHT"
      });
      return {
        id: String(created.data.id),
        body: created.data.body || normalizedBody,
        url: created.data.html_url || null,
        path: created.data.path || path,
        line: created.data.line || line,
        side: created.data.side || side
      };
    },
    listInlineComments: async (options?: { bodyIncludes?: string; authorLogin?: string }) =>
      listGithubReviewComments({
        octokit,
        owner,
        repo,
        pullNumber: prNumber,
        bodyIncludes: options?.bodyIncludes,
        authorLogin: options?.authorLogin
      }),
    updateInlineComment: async (commentId: string, body: string) => {
      const normalizedBody = normalizePostedBody(body);
      const updated = await octokit.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: Number(commentId),
        body: normalizedBody
      });
      return {
        id: String(updated.data.id),
        body: updated.data.body || normalizedBody,
        url: updated.data.html_url || null,
        path: updated.data.path || null,
        line: updated.data.line || null,
        side: updated.data.side || null
      };
    },
    resolveInlineThread,
    createStatusCheck: async (check: ProviderStatusCheck) => {
      const created = await octokit.checks.create({
        owner,
        repo,
        name: check.name,
        head_sha: params.pullRequest.headSha,
        status: check.status === "in_progress" ? "in_progress" : check.status,
        conclusion: check.conclusion as any,
        output: check.summary || check.text ? { title: check.summary || check.name, summary: check.text || "" } : undefined,
        details_url: check.detailsUrl || undefined
      });
      return {
        ...check,
        id: String(created.data.id)
      };
    },
    updateStatusCheck: async (checkId: string, check: ProviderStatusCheck) => {
      const updated = await octokit.checks.update({
        owner,
        repo,
        check_run_id: Number(checkId),
        status: check.status === "in_progress" ? "in_progress" : check.status,
        conclusion: check.conclusion as any,
        output: check.summary || check.text ? { title: check.summary || check.name, summary: check.text || "" } : undefined,
        details_url: check.detailsUrl || undefined
      });
      return { ...check, id: String(updated.data.id) };
    },
    addReaction: async (commentId: string, reaction: string) => {
      const normalizedCommentId = Number(commentId);
      try {
        await octokit.reactions.createForIssueComment({
          owner,
          repo,
          comment_id: normalizedCommentId,
          content: reaction as any
        });
        return;
      } catch {
        await octokit.reactions.createForPullRequestReviewComment({
          owner,
          repo,
          comment_id: normalizedCommentId,
          content: reaction as any
        });
      }
    },
    replyToComment: async ({ commentId, body }: { commentId: string; body: string }) => {
      const normalizedBody = normalizePostedBody(body);
      const created = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
        {
          owner,
          repo,
          pull_number: params.pullRequest.number,
          comment_id: Number(commentId),
          body: normalizedBody
        }
      );
      return {
        id: String(created.data.id),
        body: created.data.body || normalizedBody,
        url: created.data.html_url || null,
        path: created.data.path || null,
        line: created.data.line || null,
        side: created.data.side || null,
        inReplyToId: created.data.in_reply_to_id ? String(created.data.in_reply_to_id) : null
      };
    },
    pushBranch: async ({ repoPath, branchName }: { repoPath: string; branchName: string }) => {
      const token = await getInstallationToken(installationId);
      await execaAuthenticatedGit(token, ["-C", repoPath, "push", "origin", `HEAD:refs/heads/${branchName}`], {
        stdio: "inherit"
      });
    },
    deleteBranch: async (branch: string) => {
      const normalized = branch.replace(/^refs\/heads\//i, "").trim();
      if (!normalized) return;
      await octokit.git.deleteRef({
        owner,
        repo,
        ref: `heads/${normalized}`
      });
    },
    createPullRequest: async ({ title, body, head, base, draft }) => {
      const created = await octokit.pulls.create({
        owner,
        repo,
        title,
        body,
        head,
        base,
        draft: Boolean(draft)
      });
      return mapPullRequest({ pull_request: created.data });
    },
    findOpenPullRequestByHead: async ({ head, base }) => {
      const listed = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        head: `${owner}:${head}`,
        base: base || undefined,
        per_page: 100
      });
      const first = listed.data[0];
      if (!first) return null;
      return mapPullRequest({ pull_request: first });
    }
  };
}

export function createGithubAdapter(): ProviderAdapter {
  return {
    kind: "github",
    verifyWebhook: async ({ headers, body }): Promise<ProviderWebhookEvent | null> => {
      const eventName = (headers["x-github-event"] as string | undefined) || "";
      const signature = headers["x-hub-signature-256"] as string | undefined;
      const delivery = headers["x-github-delivery"] as string | undefined;
      if (!eventName || !signature || !delivery) return null;
      if (!verifySignature(env.githubWebhookSecret, body, signature)) {
        throw new Error("Invalid GitHub webhook signature");
      }
      const payload = JSON.parse(body);
      const repo = mapRepo(payload);
      const installationId = payload.installation?.id ? String(payload.installation.id) : null;

      if (eventName === "pull_request" && isPullRequestWebhookPayload(payload)) {
        return {
          provider: "github",
          type: "pull_request",
          action: payload.action,
          repo,
          pullRequest: mapPullRequest(payload),
          installationId
        };
      }

      if (
        eventName === "issue_comment" &&
        payload.action === "created" &&
        isIssueCommentWebhookPayload(payload)
      ) {
        return {
          provider: "github",
          type: "comment",
          action: payload.action,
          repo,
          pullRequest: mapPullRequest(payload),
          comment: mapComment(payload),
          author: mapAuthor(payload),
          installationId
        };
      }

      if (
        eventName === "pull_request_review_comment" &&
        payload.action === "created" &&
        isPullRequestReviewCommentWebhookPayload(payload)
      ) {
        return {
          provider: "github",
          type: "comment",
          action: payload.action,
          repo,
          pullRequest: mapPullRequest(payload),
          comment: mapComment(payload),
          author: mapAuthor(payload),
          installationId
        };
      }

      if (eventName === "reaction") {
        if (!isReactionWebhookPayload(payload) || !isPullRequestReactionPayload(payload)) {
          return null;
        }
        return {
          provider: "github",
          type: "reaction",
          action: payload.action,
          reactionContent: payload.reaction?.content || null,
          repo,
          pullRequest: mapPullRequest(payload),
          comment: mapComment(payload),
          author: mapSenderAuthor(payload),
          installationId
        };
      }

      return null;
    },
    createClient: async ({ installationId, repo, pullRequest }) =>
      createClient({ installationId, repo, pullRequest })
  };
}

export async function resolveGithubBotLogin(): Promise<string> {
  const configured = env.githubBotLogin;
  if (configured) return configured;
  return getAppSlug();
}

export {
  fetchGithubPullRequestDiffWithinLimit,
  listGithubPullRequestFiles
};

export const __githubAdapterInternals = {
  isIntegrationPermissionDenied,
  listGithubPullRequestFiles,
  listGithubReviewComments,
  fetchGithubPullRequestDiffWithinLimit
};
