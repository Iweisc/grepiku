import { prisma } from "../db/client.js";
import { ensureInstallation, ensureProvider, ensureRepo, ensureRepoInstallation, ensureUser, upsertPullRequest } from "../db/records.js";
import { enqueueCommentReplyJob, enqueueReviewJob } from "../queue/enqueue.js";
import { ProviderWebhookEvent } from "./types.js";
import { resolveRepoConfig, shouldTriggerReview, detectCommentTrigger } from "../review/triggers.js";
import { getProviderAdapter } from "./registry.js";
import { resolveGithubBotLogin } from "./github/adapter.js";
import { rememberRepoInstruction } from "../services/repoMemory.js";

function isSuggestionCommitMessage(message: string): boolean {
  const normalized = message.toLowerCase().trim();
  if (!normalized) return false;
  return (
    normalized.startsWith("apply suggestion") ||
    normalized.startsWith("apply suggestions") ||
    normalized.includes("apply suggestions from code review") ||
    normalized.includes("suggestions from code review")
  );
}

function isResolutionReply(body: string): boolean {
  const normalized = body.toLowerCase();
  return normalized.includes("fixed") || normalized.includes("resolved") || normalized.includes("done");
}

async function isSuggestionCommit(params: {
  provider: string;
  installationId: string | null;
  repo: ProviderWebhookEvent["repo"];
  pullRequest: ProviderWebhookEvent["pullRequest"];
  headSha: string | null | undefined;
}): Promise<boolean> {
  if (!params.installationId || !params.headSha) return false;
  try {
    const adapter = getProviderAdapter("github");
    const client = await adapter.createClient({
      installationId: params.installationId,
      repo: params.repo,
      pullRequest: params.pullRequest
    });
    const commit = await client.fetchCommit(params.headSha);
    return isSuggestionCommitMessage(commit.message || "");
  } catch {
    return false;
  }
}

async function resolveTargetReviewComment(params: {
  pullRequestId: number;
  providerCommentId: string;
  inReplyToId?: string | null;
}) {
  const direct = await prisma.reviewComment.findFirst({
    where: { pullRequestId: params.pullRequestId, providerCommentId: params.providerCommentId },
    include: { finding: true }
  });
  if (direct) return direct;
  if (!params.inReplyToId) return null;
  return prisma.reviewComment.findFirst({
    where: { pullRequestId: params.pullRequestId, providerCommentId: params.inReplyToId },
    include: { finding: true }
  });
}

export async function handleWebhookEvent(event: ProviderWebhookEvent): Promise<void> {
  const provider = await ensureProvider({
    kind: event.provider,
    name: "GitHub",
    baseUrl: "https://github.com",
    apiUrl: null
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
    const latestRun = await prisma.reviewRun.findFirst({
      where: { pullRequestId: pullRequest.id },
      orderBy: { createdAt: "desc" }
    });
    if (
      latestRun &&
      latestRun.headSha === event.pullRequest.headSha &&
      latestRun.status !== "failed"
    ) {
      return;
    }
    const shouldTrigger = shouldTriggerReview({
      trigger: event.action,
      config,
      pullRequest: event.pullRequest
    });
    if (!shouldTrigger) return;
    if (event.action === "synchronize") {
      const skipSuggestion = await isSuggestionCommit({
        provider: event.provider,
        installationId: installation.externalId,
        repo: event.repo,
        pullRequest: event.pullRequest,
        headSha: event.pullRequest.headSha
      });
      if (skipSuggestion) return;
    }

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
    const botLogin = await resolveGithubBotLogin().catch(() => "");
    if (botLogin && event.author.login.toLowerCase() === botLogin.toLowerCase()) {
      return;
    }
    const commentBody = event.comment.body || "";
    const commentTrigger = detectCommentTrigger(commentBody, config);

    const latestRun = await prisma.reviewRun.findFirst({
      where: { pullRequestId: pullRequest.id },
      orderBy: { createdAt: "desc" }
    });
    const providerCommentId = event.comment.id;
    const targetComment = await resolveTargetReviewComment({
      pullRequestId: pullRequest.id,
      providerCommentId,
      inReplyToId: event.comment.inReplyToId
    });

    if (latestRun) {
      const canonicalCommentId =
        targetComment?.finding?.commentId || event.comment.inReplyToId || providerCommentId;
      const action = isResolutionReply(commentBody) ? "resolved" : null;
      await prisma.feedback.create({
        data: {
          reviewRunId: latestRun.id,
          type: "reply",
          action,
          commentId: canonicalCommentId,
          metadata: {
            author: event.author.login,
            body: commentBody,
            providerCommentId
          }
        }
      });
    }

    const shouldAttemptMemory = Boolean(targetComment) || commentTrigger === "mention";
    if (shouldAttemptMemory) {
      await rememberRepoInstruction({
        repoId: repo.id,
        commentBody,
        author: event.author.login,
        commentId: providerCommentId,
        commentUrl: event.comment.url || null
      }).catch(() => undefined);
    }

    const shouldAcknowledge = Boolean(commentTrigger) || Boolean(targetComment);
    if (installation.externalId && shouldAcknowledge) {
      try {
        const adapter = getProviderAdapter(event.provider);
        const client = await adapter.createClient({
          installationId: installation.externalId,
          repo: event.repo,
          pullRequest: event.pullRequest
        });
        if (client.addReaction) {
          await client.addReaction(event.comment.id, "eyes");
        }
      } catch {
        // Ignore reaction failures (comment types or permissions may not support it)
      }
    }

    const shouldReply =
      commentTrigger === "mention" ||
      (Boolean(targetComment) && !isResolutionReply(commentBody) && commentBody.trim().length > 0);
    if (shouldReply) {
      const replyInThread =
        Boolean(event.comment.path) ||
        Boolean(event.comment.inReplyToId) ||
        targetComment?.kind === "inline";
      console.log(
        `[comment ${providerCommentId}] enqueue mention reply (trigger=${commentTrigger || "thread-reply"} target=${targetComment?.providerCommentId || "none"} thread=${replyInThread ? "yes" : "no"})`
      );
      await enqueueCommentReplyJob({
        provider: event.provider,
        installationId: installation.externalId,
        repoId: repo.id,
        pullRequestId: pullRequest.id,
        prNumber: event.pullRequest.number,
        commentId: event.comment.id,
        commentBody,
        commentAuthor: event.author.login,
        commentUrl: event.comment.url,
        replyInThread
      });
    }

    if (!commentTrigger) return;

    if (commentTrigger === "review") {
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
    }

    return;
  }

  if (event.type === "reaction") {
    const latestRun = await prisma.reviewRun.findFirst({
      where: { pullRequestId: pullRequest.id },
      orderBy: { createdAt: "desc" }
    });
    if (latestRun) {
      const providerCommentId = event.comment.id;
      const reviewComment = await resolveTargetReviewComment({
        pullRequestId: pullRequest.id,
        providerCommentId,
        inReplyToId: event.comment.inReplyToId
      });
      const canonicalCommentId =
        reviewComment?.finding?.commentId || event.comment.inReplyToId || providerCommentId;
      await prisma.feedback.create({
        data: {
          reviewRunId: latestRun.id,
          type: "reaction",
          sentiment: event.action,
          commentId: canonicalCommentId,
          metadata: {
            provider: event.provider,
            author: event.author.login,
            providerCommentId
          }
        }
      });
    }
  }
}
