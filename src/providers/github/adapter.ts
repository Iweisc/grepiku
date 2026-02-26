import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import { loadEnv } from "../../config/env.js";
import { getInstallationOctokit, getInstallationToken, getAppSlug } from "../../github/auth.js";
import {
  ProviderAdapter,
  ProviderClient,
  ProviderRepo,
  ProviderPullRequest,
  ProviderReviewComment,
  ProviderStatusCheck,
  ProviderWebhookEvent
} from "../types.js";
import { ensureGitRepoCheckout } from "../repoCheckout.js";

const env = loadEnv();

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
    avatarUrl: user.avatar_url ?? null
  };
}

function normalizePostedBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\+n/g, "\n")
    .replace(/(^|[\s:;,.!?])\/n(?=\s*(?:\d+\.|[-*]|$))/gm, "$1\n")
    .trim();
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
  result: Map<string, ReviewThreadLookup>
) {
  for (const comment of comments?.nodes || []) {
    const databaseId = comment?.databaseId;
    if (databaseId) {
      result.set(String(databaseId), { threadId, isResolved });
    }
  }
}

async function appendThreadComments(params: {
  graphql: GraphqlRequest;
  threadId: string;
  isResolved: boolean;
  commentsAfter: string;
  result: Map<string, ReviewThreadLookup>;
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
  while (commentsAfter) {
    const page = (await params.graphql(commentsQuery, {
      threadId: params.threadId,
      commentsAfter
    })) as ThreadCommentsPage;
    const comments = page.node?.comments;
    appendCommentIds(comments, params.threadId, params.isResolved, params.result);
    if (!comments?.pageInfo?.hasNextPage || !comments.pageInfo.endCursor) break;
    commentsAfter = comments.pageInfo.endCursor;
  }
}

export async function loadGithubReviewThreadMap(params: {
  graphql: GraphqlRequest;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<Map<string, ReviewThreadLookup>> {
  const result = new Map<string, ReviewThreadLookup>();
  let after: string | null = null;

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

  while (true) {
    const page = (await params.graphql(query, {
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      after
    })) as GraphqlThreadPage;
    const threads = page.repository?.pullRequest?.reviewThreads;
    for (const thread of threads?.nodes || []) {
      const threadId = thread?.id;
      if (!threadId) continue;
      const isResolved = Boolean(thread.isResolved);
      const comments = thread.comments;
      appendCommentIds(comments, threadId, isResolved, result);
      if (comments?.pageInfo?.hasNextPage && comments.pageInfo.endCursor) {
        await appendThreadComments({
          graphql: params.graphql,
          threadId,
          isResolved,
          commentsAfter: comments.pageInfo.endCursor,
          result
        });
      }
    }

    if (!threads?.pageInfo?.hasNextPage || !threads.pageInfo.endCursor) break;
    after = threads.pageInfo.endCursor;
  }

  return result;
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
    await (octokit as any).graphql(mutation, { threadId: entry.threadId });
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
        authorLogin: response.data.author?.login || response.data.commit?.author?.name || null
      };
    },
    fetchDiffPatch: async () => {
      const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber,
        headers: { accept: "application/vnd.github.v3.diff" }
      });
      return response.data as unknown as string;
    },
    listChangedFiles: async () => {
      const files = await octokit.paginate(octokit.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      });
      return files.map((file) => ({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? null
      }));
    },
    ensureRepoCheckout: async ({ headSha }) => {
      const token = await getInstallationToken(installationId);
      return ensureGitRepoCheckout({
        headSha,
        owner,
        repo,
        token
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
    listInlineComments: async () => {
      const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      });
      return comments.map((comment) => ({
        id: String(comment.id),
        body: comment.body || "",
        url: comment.html_url || null,
        path: comment.path || null,
        line: comment.line || null,
        side: comment.side || null,
        createdAt: comment.created_at || null
      }));
    },
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

      if (eventName === "pull_request") {
        return {
          provider: "github",
          type: "pull_request",
          action: payload.action,
          repo,
          pullRequest: mapPullRequest(payload),
          installationId
        };
      }

      if (eventName === "issue_comment" && payload.issue?.pull_request) {
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

      if (eventName === "pull_request_review_comment") {
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
        return {
          provider: "github",
          type: "reaction",
          action: payload.reaction?.content || payload.action,
          repo,
          pullRequest: mapPullRequest(payload),
          comment: mapComment(payload),
          author: mapAuthor(payload),
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
