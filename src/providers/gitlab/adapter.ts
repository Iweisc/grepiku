import crypto from "crypto";
import { loadEnv } from "../../config/env.js";
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

function verifyToken(secret: string, headerToken?: string): boolean {
  if (!secret) return true;
  if (!headerToken) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(headerToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function mapRepo(payload: any): ProviderRepo {
  const project = payload.project || payload.repository || {};
  const fullName = project.path_with_namespace || project.full_path || "";
  const owner = fullName.split("/")[0] || project.namespace?.path || "";
  const name = project.path || project.name || "";
  return {
    externalId: String(project.id || ""),
    owner,
    name,
    fullName,
    defaultBranch: project.default_branch || null,
    archived: Boolean(project.archived),
    private: project.visibility ? project.visibility !== "public" : undefined,
    url: project.web_url || null
  };
}

function mapPullRequest(payload: any): ProviderPullRequest {
  const mr = payload.object_attributes || payload.merge_request || {};
  const author = payload.user || payload.author || {};
  return {
    externalId: String(mr.id || ""),
    number: Number(mr.iid || 0),
    title: mr.title || null,
    body: mr.description || null,
    url: mr.url || mr.web_url || null,
    state: mr.state || mr.action || "opened",
    baseRef: mr.target_branch || null,
    headRef: mr.source_branch || null,
    baseSha: mr.diff_refs?.base_sha || null,
    headSha: mr.last_commit?.id || mr.diff_refs?.head_sha || "",
    draft: Boolean(mr.work_in_progress || mr.draft),
    author: author.id
      ? {
          externalId: String(author.id),
          login: author.username || author.name || "",
          name: author.name || null,
          avatarUrl: author.avatar_url || null
        }
      : null,
    labels: Array.isArray(mr.labels) ? mr.labels : []
  };
}

function mapComment(payload: any): ProviderReviewComment {
  const note = payload.object_attributes || payload.note || {};
  return {
    id: String(note.id || ""),
    body: note.note || note.body || "",
    url: note.url || null,
    path: note.position?.new_path || note.position?.old_path || null,
    line: note.position?.new_line || note.position?.old_line || null,
    side: note.position?.new_line ? "RIGHT" : note.position?.old_line ? "LEFT" : null,
    createdAt: note.created_at || null
  };
}

async function gitlabRequest<T>(
  path: string,
  options: { method?: string; body?: any } = {}
): Promise<T> {
  const url = `${env.gitlabBaseUrl.replace(/\/$/, "")}/api/v4${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (env.gitlabApiToken) {
    headers["PRIVATE-TOKEN"] = env.gitlabApiToken;
  }
  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function fetchMergeRequest(projectId: string, iid: number): Promise<any> {
  return gitlabRequest(`/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}`);
}

async function fetchMergeRequestChanges(projectId: string, iid: number): Promise<any> {
  return gitlabRequest(`/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/changes`);
}

function buildPatchFromChanges(changes: any[]): string {
  return changes
    .map((change) => {
      const oldPath = change.old_path || change.new_path;
      const newPath = change.new_path || change.old_path;
      const header = `diff --git a/${oldPath} b/${newPath}\n--- a/${oldPath}\n+++ b/${newPath}\n`;
      return header + (change.diff || "");
    })
    .join("\n");
}

function createClient(params: {
  repo: ProviderRepo;
  pullRequest: ProviderPullRequest;
}): ProviderClient {
  const projectId = params.repo.externalId;
  const iid = params.pullRequest.number;

  const createStatus = async (check: ProviderStatusCheck) => {
    const state =
      check.status === "queued"
        ? "pending"
        : check.status === "in_progress"
          ? "running"
          : check.conclusion === "success"
            ? "success"
            : check.conclusion === "failure"
              ? "failed"
              : "canceled";
    const status = await gitlabRequest(
      `/projects/${encodeURIComponent(projectId)}/statuses/${params.pullRequest.headSha}`,
      {
        method: "POST",
        body: {
          state,
          name: check.name,
          description: check.summary || undefined,
          target_url: check.detailsUrl || undefined
        }
      }
    );
    return { ...check, id: String(status.id || "") };
  };

  return {
    provider: "gitlab",
    repo: params.repo,
    pullRequest: params.pullRequest,
    fetchPullRequest: async () => {
      const mr = await fetchMergeRequest(projectId, iid);
      return {
        ...params.pullRequest,
        externalId: String(mr.id || params.pullRequest.externalId),
        title: mr.title || params.pullRequest.title,
        body: mr.description || params.pullRequest.body,
        url: mr.web_url || params.pullRequest.url,
        state: mr.state || params.pullRequest.state,
        baseRef: mr.target_branch || params.pullRequest.baseRef,
        headRef: mr.source_branch || params.pullRequest.headRef,
        baseSha: mr.diff_refs?.base_sha || params.pullRequest.baseSha,
        headSha: mr.sha || mr.diff_refs?.head_sha || params.pullRequest.headSha,
        draft: Boolean(mr.work_in_progress || mr.draft)
      };
    },
    fetchDiffPatch: async () => {
      const changes = await fetchMergeRequestChanges(projectId, iid);
      return buildPatchFromChanges(changes.changes || []);
    },
    listChangedFiles: async () => {
      const changes = await fetchMergeRequestChanges(projectId, iid);
      return (changes.changes || []).map((change: any) => ({
        path: change.new_path || change.old_path,
        status: change.new_file ? "added" : change.deleted_file ? "deleted" : "modified",
        patch: change.diff || null
      }));
    },
    ensureRepoCheckout: async ({ headSha }) => {
      if (!env.gitlabApiToken) {
        throw new Error("GITLAB_API_TOKEN required for repo checkout");
      }
      return ensureGitRepoCheckout({
        headSha,
        owner: params.repo.owner,
        repo: params.repo.name,
        token: env.gitlabApiToken,
        baseUrl: env.gitlabBaseUrl
      });
    },
    updatePullRequestBody: async (body: string) => {
      await gitlabRequest(`/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}`, {
        method: "PUT",
        body: { description: body }
      });
    },
    createSummaryComment: async (body: string) => {
      const note = await gitlabRequest(`/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes`, {
        method: "POST",
        body: { body }
      });
      return {
        id: String(note.id),
        body: note.body || body,
        url: note.web_url || null
      };
    },
    updateSummaryComment: async (commentId: string, body: string) => {
      const note = await gitlabRequest(
        `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes/${commentId}`,
        {
          method: "PUT",
          body: { body }
        }
      );
      return {
        id: String(note.id),
        body: note.body || body,
        url: note.web_url || null
      };
    },
    createInlineComment: async ({ path, line, side, body }) => {
      const mr = await fetchMergeRequest(projectId, iid);
      const diffRefs = mr.diff_refs;
      const position: any = {
        position_type: "text",
        base_sha: diffRefs.base_sha,
        start_sha: diffRefs.start_sha,
        head_sha: diffRefs.head_sha
      };
      if (side === "LEFT") {
        position.old_path = path;
        position.old_line = line;
      } else {
        position.new_path = path;
        position.new_line = line;
      }
      const note = await gitlabRequest(`/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes`, {
        method: "POST",
        body: { body, position }
      });
      return {
        id: String(note.id),
        body: note.body || body,
        url: note.web_url || null,
        path,
        line,
        side
      };
    },
    listInlineComments: async () => {
      const notes = await gitlabRequest(`/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes`);
      return (notes || [])
        .filter((note: any) => note.position)
        .map((note: any) => ({
          id: String(note.id),
          body: note.body || "",
          url: note.web_url || null,
          path: note.position?.new_path || note.position?.old_path || null,
          line: note.position?.new_line || note.position?.old_line || null,
          side: note.position?.new_line ? "RIGHT" : note.position?.old_line ? "LEFT" : null,
          createdAt: note.created_at || null
        }));
    },
    updateInlineComment: async (commentId: string, body: string) => {
      const note = await gitlabRequest(
        `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes/${commentId}`,
        { method: "PUT", body: { body } }
      );
      return {
        id: String(note.id),
        body: note.body || body,
        url: note.web_url || null
      };
    },
    createStatusCheck: async (check: ProviderStatusCheck) => createStatus(check),
    updateStatusCheck: async (_checkId: string, check: ProviderStatusCheck) => createStatus(check)
  };
}

export const gitlabAdapter: ProviderAdapter = {
  kind: "gitlab",
  verifyWebhook: async ({ headers, body }): Promise<ProviderWebhookEvent | null> => {
    const event = (headers["x-gitlab-event"] as string | undefined) || "";
    const token = headers["x-gitlab-token"] as string | undefined;
    if (!event) return null;
    if (!verifyToken(env.gitlabWebhookSecret, token)) {
      throw new Error("Invalid GitLab webhook token");
    }
    const payload = JSON.parse(body);
    if (payload.object_kind === "merge_request") {
      return {
        provider: "gitlab",
        type: "pull_request",
        action: payload.object_attributes?.action || payload.object_attributes?.state || "update",
        repo: mapRepo(payload),
        pullRequest: mapPullRequest(payload),
        installationId: null
      };
    }
    if (payload.object_kind === "note" && payload.object_attributes?.noteable_type === "MergeRequest") {
      return {
        provider: "gitlab",
        type: "comment",
        action: payload.object_attributes?.action || "created",
        repo: mapRepo(payload),
        pullRequest: mapPullRequest(payload),
        comment: mapComment(payload),
        author: {
          externalId: String(payload.user?.id || ""),
          login: payload.user?.username || payload.user?.name || "",
          name: payload.user?.name || null,
          avatarUrl: payload.user?.avatar_url || null
        },
        installationId: null
      };
    }
    return null;
  },
  createClient: async ({ repo, pullRequest }) => createClient({ repo, pullRequest })
};
