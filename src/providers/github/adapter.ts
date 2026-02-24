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

function createClient(params: {
  installationId: string | null;
  repo: ProviderRepo;
  pullRequest: ProviderPullRequest;
  baseUrl?: string | null;
}): ProviderClient {
  const installationId = params.installationId ? Number(params.installationId) : null;
  const baseUrl = params.baseUrl || undefined;
  if (!installationId) {
    throw new Error("GitHub installationId required for provider client");
  }
  const octokit = getInstallationOctokit(installationId, baseUrl);
  const owner = params.repo.owner;
  const repo = params.repo.name;
  const prNumber = params.pullRequest.number;

  return {
    provider: params.baseUrl ? "ghes" : "github",
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
    fetchDiffPatch: async () => {
      const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber,
        headers: { accept: "application/vnd.github.v3.diff" }
      });
      return response.data as unknown as string;
    },
    listChangedFiles: async () =>
      octokit.paginate(octokit.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      }),
    ensureRepoCheckout: async ({ headSha }) => {
      const token = await getInstallationToken(installationId);
      return ensureGitRepoCheckout({
        headSha,
        owner,
        repo,
        token,
        baseUrl: params.baseUrl || undefined
      });
    },
    updatePullRequestBody: async (body: string) => {
      await octokit.pulls.update({ owner, repo, pull_number: prNumber, body });
    },
    createSummaryComment: async (body: string) => {
      const created = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body
      });
      return {
        id: String(created.data.id),
        body: created.data.body || body,
        url: created.data.html_url || null
      };
    },
    updateSummaryComment: async (commentId: string, body: string) => {
      const updated = await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: Number(commentId),
        body
      });
      return {
        id: String(updated.data.id),
        body: updated.data.body || body,
        url: updated.data.html_url || null
      };
    },
    createInlineComment: async ({ path, line, side, body }) => {
      const created = await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        body,
        path,
        line,
        side: side === "LEFT" ? "LEFT" : "RIGHT"
      });
      return {
        id: String(created.data.id),
        body: created.data.body || body,
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
      const updated = await octokit.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: Number(commentId),
        body
      });
      return {
        id: String(updated.data.id),
        body: updated.data.body || body,
        url: updated.data.html_url || null,
        path: updated.data.path || null,
        line: updated.data.line || null,
        side: updated.data.side || null
      };
    },
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
      await octokit.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: Number(commentId),
        content: reaction as any
      });
    }
  };
}

export function createGithubAdapter(kind: "github" | "ghes", baseUrl?: string): ProviderAdapter {
  return {
    kind,
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
          provider: kind,
          type: "pull_request",
          action: payload.action,
          repo,
          pullRequest: mapPullRequest(payload),
          installationId
        };
      }

      if (eventName === "issue_comment" && payload.issue?.pull_request) {
        return {
          provider: kind,
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
          provider: kind,
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
          provider: kind,
          type: "reaction",
          action: payload.action,
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
      createClient({ installationId, repo, pullRequest, baseUrl })
  };
}

export async function resolveGithubBotLogin(baseUrl?: string): Promise<string> {
  const configured = env.githubBotLogin;
  if (configured) return configured;
  return getAppSlug(baseUrl);
}
