import { prisma } from "../db/client.js";
import { ensureInstallation, ensureProvider, ensureRepo, ensureRepoInstallation, ensureUser, upsertPullRequest } from "../db/records.js";
import { enqueueCommentReplyJob, enqueueReviewJob } from "../queue/enqueue.js";
import { loadEnv } from "../config/env.js";
import { ProviderWebhookEvent } from "./types.js";
import { resolveRepoConfig, shouldTriggerReview, isManualTrigger } from "../review/triggers.js";

const env = loadEnv();

function providerBaseUrl(kind: string): string {
  if (kind === "gitlab") return env.gitlabBaseUrl;
  if (kind === "ghes" && env.ghesBaseUrl) return env.ghesBaseUrl;
  return "https://github.com";
}

export async function handleWebhookEvent(event: ProviderWebhookEvent): Promise<void> {
  const provider = await ensureProvider({
    kind: event.provider,
    name: event.provider === "gitlab" ? "GitLab" : event.provider === "ghes" ? "GitHub Enterprise" : "GitHub",
    baseUrl: providerBaseUrl(event.provider),
    apiUrl: event.provider === "gitlab" ? `${env.gitlabBaseUrl.replace(/\/$/, "")}/api/v4` : null
  });

  const installationExternalId = event.installationId || event.repo.owner || event.repo.fullName;
  const installation = await ensureInstallation({
    providerId: provider.id,
    externalId: installationExternalId || "unknown",
    accountLogin: event.repo.owner || event.repo.fullName || "unknown",
    accountType: "org"
  });

  const repo = await ensureRepo({
    providerId: provider.id,
    externalId: event.repo.externalId || event.repo.fullName,
    owner: event.repo.owner,
    name: event.repo.name,
    fullName: event.repo.fullName,
    defaultBranch: event.repo.defaultBranch,
    archived: event.repo.archived,
    private: event.repo.private
  });

  await ensureRepoInstallation({ repoId: repo.id, installationId: installation.id });

  const author = event.pullRequest.author
    ? await ensureUser({
        providerId: provider.id,
        externalId: event.pullRequest.author.externalId,
        login: event.pullRequest.author.login,
        name: event.pullRequest.author.name,
        avatarUrl: event.pullRequest.author.avatarUrl
      })
    : null;

  const pullRequest = await upsertPullRequest({
    repoId: repo.id,
    externalId: event.pullRequest.externalId,
    number: event.pullRequest.number,
    title: event.pullRequest.title,
    body: event.pullRequest.body,
    url: event.pullRequest.url,
    state: event.pullRequest.state,
    baseRef: event.pullRequest.baseRef,
    headRef: event.pullRequest.headRef,
    baseSha: event.pullRequest.baseSha,
    headSha: event.pullRequest.headSha || event.pullRequest.baseSha || "",
    draft: event.pullRequest.draft,
    authorId: author?.id || null
  });

  const config = await resolveRepoConfig(repo.id, provider.kind);

  if (event.type === "pull_request") {
    if (event.pullRequest.state === "closed") return;
    const shouldTrigger = shouldTriggerReview({
      trigger: event.action,
      config,
      pullRequest: event.pullRequest
    });
    if (!shouldTrigger) return;

    await enqueueReviewJob({
      provider: event.provider,
      installationId: installation.externalId,
      repoId: repo.id,
      pullRequestId: pullRequest.id,
      prNumber: event.pullRequest.number,
      headSha: event.pullRequest.headSha,
      trigger: event.action
    });
    return;
  }

  if (event.type === "comment") {
    const commentBody = event.comment.body || "";
    const manual = isManualTrigger(commentBody, config);

    const latestRun = await prisma.reviewRun.findFirst({
      where: { pullRequestId: pullRequest.id },
      orderBy: { createdAt: "desc" }
    });
    if (latestRun) {
      const normalized = commentBody.toLowerCase();
      const action = normalized.includes("fixed") || normalized.includes("resolved") || normalized.includes("done")
        ? "resolved"
        : null;
      await prisma.feedback.create({
        data: {
          reviewRunId: latestRun.id,
          type: "reply",
          action,
          commentId: event.comment.id,
          metadata: {
            author: event.author.login,
            body: commentBody
          }
        }
      });
    }
    if (!manual) return;

    await enqueueCommentReplyJob({
      provider: event.provider,
      installationId: installation.externalId,
      repoId: repo.id,
      pullRequestId: pullRequest.id,
      prNumber: event.pullRequest.number,
      commentId: event.comment.id,
      commentBody,
      commentAuthor: event.author.login,
      commentUrl: event.comment.url
    });

    await enqueueReviewJob({
      provider: event.provider,
      installationId: installation.externalId,
      repoId: repo.id,
      pullRequestId: pullRequest.id,
      prNumber: event.pullRequest.number,
      headSha: event.pullRequest.headSha,
      trigger: "manual",
      force: true
    });

    return;
  }

  if (event.type === "reaction") {
    const latestRun = await prisma.reviewRun.findFirst({
      where: { pullRequestId: pullRequest.id },
      orderBy: { createdAt: "desc" }
    });
    if (latestRun) {
      await prisma.feedback.create({
        data: {
          reviewRunId: latestRun.id,
          type: "reaction",
          sentiment: event.action,
          commentId: event.comment.id,
          metadata: {
            provider: event.provider,
            author: event.author.login
          }
        }
      });
    }
  }
}
