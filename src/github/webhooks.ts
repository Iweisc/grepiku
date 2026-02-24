import { Webhooks } from "@octokit/webhooks";
import { reviewQueue } from "../queue/index.js";
import { loadEnv } from "../config/env.js";
import { getAppSlug, getInstallationOctokit } from "./auth.js";

const env = loadEnv();

export const webhooks = new Webhooks({
  secret: env.githubWebhookSecret
});

async function enqueueReview(params: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  trigger: string;
  force?: boolean;
}) {
  await reviewQueue.add(
    "pr-review",
    {
      ...params
    },
    {
      removeOnComplete: true,
      removeOnFail: false
    }
  );
}

async function enqueueCommentReply(params: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  commentBody: string;
  commentAuthor: string;
  commentUrl?: string;
}) {
  await reviewQueue.add(
    "comment-reply",
    {
      ...params
    },
    {
      removeOnComplete: true,
      removeOnFail: false
    }
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function isBotMentioned(body: string): Promise<boolean> {
  if (!body) return false;
  const configured = env.githubBotLogin;
  let handle = configured;
  if (!handle) {
    try {
      handle = await getAppSlug();
    } catch {
      handle = "";
    }
  }
  if (!handle) return false;
  const slug = handle.replace(/\[bot\]$/i, "");
  const candidates = slug.toLowerCase() === handle.toLowerCase() ? [slug] : [slug, handle];
  const pattern = candidates.map((c) => `@${escapeRegExp(c)}`).join("|");
  const regex = new RegExp(`(?:^|\\s)(${pattern})(?=\\b|\\s|$|[.,!?])`, "i");
  return regex.test(body);
}

webhooks.on(
  [
    "pull_request.opened",
    "pull_request.reopened",
    "pull_request.ready_for_review",
    "pull_request.synchronize"
  ],
  async ({ payload }) => {
    const installationId = payload.installation?.id;
    if (!installationId) return;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.pull_request.number;
    const headSha = payload.pull_request.head.sha;
    await enqueueReview({
      installationId,
      owner,
      repo,
      prNumber,
      headSha,
      trigger: payload.action
    });
  }
);

webhooks.on("issue_comment.created", async ({ payload }) => {
  const installationId = payload.installation?.id;
  if (!installationId) return;
  const body = payload.comment.body || "";
  if (!payload.issue.pull_request) return;
  if (payload.issue.state === "closed") return;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.issue.number;
  const octokit = getInstallationOctokit(installationId);
  const isBot =
    payload.comment.user?.type === "Bot" || payload.sender?.type === "Bot";

  const shouldRespond = !isBot && (await isBotMentioned(body));
  if (shouldRespond) {
    try {
      await octokit.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: payload.comment.id,
        content: "eyes"
      });
    } catch {
      // best-effort acknowledgement
    }

    await enqueueCommentReply({
      installationId,
      owner,
      repo,
      prNumber,
      commentId: payload.comment.id,
      commentBody: body,
      commentAuthor: payload.comment.user?.login || payload.sender?.login || "unknown",
      commentUrl: payload.comment.html_url
    });
  }

  if (!/(^|\s)\/review(\s|$)/i.test(body)) return;
  const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const headSha = pr.data.head.sha;

  await enqueueReview({
    installationId,
    owner,
    repo,
    prNumber,
    headSha,
    trigger: "issue_comment",
    force: true
  });
});
