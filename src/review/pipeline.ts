import fs from "fs/promises";
import path from "path";
import { prisma } from "../db/client.js";
import { getInstallationOctokit, getInstallationToken } from "../github/auth.js";
import { loadEnv } from "../config/env.js";
import { loadRepoConfig } from "./config.js";
import { createRunDirs, writeBundleFiles } from "./bundle.js";
import { buildReviewerPrompt, buildEditorPrompt, buildVerifierPrompt } from "./prompts.js";
import { runCodexStage } from "../runner/codexRunner.js";
import { parseAndValidateJson, readAndValidateJson } from "./json.js";
import {
  ReviewSchema,
  VerdictsSchema,
  ChecksSchema,
  ReviewComment,
  ReviewCommentSchema
} from "./schemas.js";
import {
  buildDiffIndex,
  isLineInDiff,
  hunkHashForComment,
  contextHashForComment,
  normalizePath
} from "./diff.js";
import { fingerprintForComment, matchKeyForComment } from "./findings.js";
import { ReviewOutput } from "./schemas.js";
import { minimatch } from "minimatch";
import {
  buildLocalDiffPatch,
  ensureRepoCheckout,
  fetchDiffPatch,
  isDiffTooLargeError,
  listChangedFiles,
  renderPrMarkdown
} from "./pr-data.js";

const env = loadEnv();

export type ReviewJobData = {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  trigger: string;
  force?: boolean;
};

 

function filterAndNormalizeComments(
  review: ReviewOutput,
  diffIndex: ReturnType<typeof buildDiffIndex>,
  maxInline: number,
  ignoreGlobs: string[]
): ReviewComment[] {
  const comments: ReviewComment[] = [];
  for (const comment of review.comments) {
    if (ignoreGlobs.some((pattern) => minimatch(comment.path, pattern))) continue;
    const evidence = (comment.evidence || "").trim();
    if (evidence.length === 0 || evidence === "\"\"" || evidence === "''") continue;
    if (comment.severity === "blocking" && !comment.suggested_patch) continue;
    if (!isLineInDiff(diffIndex, comment)) continue;
    comments.push(comment);
    if (comments.length >= maxInline) break;
  }
  return comments;
}

function formatInlineComment(comment: ReviewComment): string {
  const marker = `<!-- grepiku:${comment.comment_id} -->`;
  const escapeHtml = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const normalizeSuggestedPatch = (patch: string) => {
    let normalized = patch.replace(/\\n/g, "\n");
    normalized = normalized
      .replace(/^```(?:suggestion|diff)?\n?/i, "")
      .replace(/```$/, "")
      .trim();
    const lines = normalized.split("\n");
    const hasDiffMarkers = lines.some(
      (line) =>
        line.startsWith("diff") ||
        line.startsWith("@@") ||
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("+") ||
        line.startsWith("-")
    );
    if (hasDiffMarkers) {
      const added = lines
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1));
      if (added.length > 0) {
        normalized = added.join("\n");
      } else {
        const kept = lines.filter(
          (line) =>
            !line.startsWith("-") &&
            !line.startsWith("@@") &&
            !line.startsWith("diff") &&
            !line.startsWith("+++ ") &&
            !line.startsWith("--- ")
        );
        if (kept.length > 0) {
          normalized = kept.join("\n");
        }
      }
    }
    return normalized.trimEnd();
  };
  const bodyParts = [
    marker,
    `**${comment.severity.toUpperCase()}** ${comment.title}`,
    `Category: ${comment.category}`,
    `Evidence: ${comment.evidence}`,
    comment.body
  ];

  const suggestedPatch = comment.suggested_patch
    ? normalizeSuggestedPatch(comment.suggested_patch)
    : null;

  if (suggestedPatch) {
    bodyParts.push("Suggested change:", "```suggestion", suggestedPatch, "```");
  }

  const fixPrompt = [
    "You are an AI coding assistant.",
    `Fix the issue in ${comment.path}:${comment.line} (${comment.side}).`,
    `Title: ${comment.title}`,
    `Category: ${comment.category}`,
    `Severity: ${comment.severity}`,
    `Evidence: ${comment.evidence}`,
    `Details: ${comment.body}`
  ];
  if (suggestedPatch) {
    fixPrompt.push("Suggested change:", suggestedPatch);
  }

  bodyParts.push("<details>", "<summary>Fix with AI</summary>", "");
  bodyParts.push("<pre><code>");
  bodyParts.push(escapeHtml(fixPrompt.join("\n")));
  bodyParts.push("</code></pre>", "</details>");
  return bodyParts.join("\n\n");
}

function extractCommentId(body: string): string | null {
  const match = body.match(/<!--\s*grepiku:([^\s]+)\s*-->/);
  return match ? match[1] : null;
}

function renderStatusComment(params: {
  summary: ReviewOutput["summary"];
  newFindings: Array<{ title: string; url?: string }>;
  openFindings: Array<{ title: string; url?: string }>;
  fixedFindings: Array<{ title: string }>;
  checks: {
    lint: { status: string; summary: string; top_errors: string[] };
    build: { status: string; summary: string; top_errors: string[] };
    test: { status: string; summary: string; top_errors: string[] };
  };
}): string {
  const { summary, newFindings, openFindings, fixedFindings, checks } = params;
  const renderList = (items: Array<{ title: string; url?: string }>) => {
    if (items.length === 0) return "- (none)";
    return items.map((item) => (item.url ? `- [${item.title}](${item.url})` : `- ${item.title}`)).join("\n");
  };

  const renderFixed = () => {
    if (fixedFindings.length === 0) return "- (none)";
    return fixedFindings.map((item) => `- ${item.title}`).join("\n");
  };

  const renderCheck = (name: string, result: { status: string; summary: string; top_errors: string[] }) => {
    const errors = result.top_errors.length ? result.top_errors.map((e) => `  - ${e}`).join("\n") : "  - (none)";
    return `**${name}**: ${result.status} - ${result.summary}\n${errors}`;
  };

  return [
    "## AI Review Status",
    "",
    `**Overview:** ${summary.overview}`,
    `**Risk:** ${summary.risk}`,
    "",
    "### New",
    renderList(newFindings),
    "",
    "### Still Open",
    renderList(openFindings),
    "",
    "### Fixed Since Last Run",
    renderFixed(),
    "",
    "### Checks",
    renderCheck("lint", checks.lint),
    "",
    renderCheck("build", checks.build),
    "",
    renderCheck("test", checks.test)
  ].join("\n");
}

function renderReviewingComment(): string {
  return [
    "## AI Review Status",
    "",
    "Review in progress. Grepiku is analyzing the PR and will update this comment when done."
  ].join("\n");
}

async function upsertStatusComment(params: {
  octokit: ReturnType<typeof getInstallationOctokit>;
  owner: string;
  repo: string;
  prNumber: number;
  pullRequestId: number;
  body: string;
}) {
  const { octokit, owner, repo, prNumber, pullRequestId, body } = params;
  const statusComment = await prisma.statusComment.findUnique({
    where: { pullRequestId }
  });

  if (statusComment) {
    try {
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: Number(statusComment.githubCommentId),
        body
      });
      return;
    } catch (err: unknown) {
      const status = (err as { status?: number; response?: { status?: number } })?.status ??
        (err as { response?: { status?: number } })?.response?.status;
      if (status !== 404) {
        throw err;
      }
      await prisma.statusComment.delete({ where: { pullRequestId } }).catch(() => undefined);
    }
  }

  const created = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body
  });
  await prisma.statusComment.create({
    data: {
      pullRequestId,
      githubCommentId: String(created.data.id)
    }
  });
}

function buildFixPrompt(comments: ReviewComment[]): string {
  if (comments.length === 0) {
    return [
      "There are no review findings to fix.",
      "If you made changes, ensure tests and lint still pass."
    ].join("\n");
  }

  const normalizeSuggestedPatch = (patch: string) => {
    let normalized = patch.replace(/\\n/g, "\n");
    normalized = normalized
      .replace(/^```(?:suggestion|diff)?\n?/i, "")
      .replace(/```$/, "")
      .trim();
    const lines = normalized.split("\n");
    const hasDiffMarkers = lines.some(
      (line) =>
        line.startsWith("diff") ||
        line.startsWith("@@") ||
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("+") ||
        line.startsWith("-")
    );
    if (hasDiffMarkers) {
      const added = lines
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1));
      if (added.length > 0) {
        normalized = added.join("\n");
      } else {
        const kept = lines.filter(
          (line) =>
            !line.startsWith("-") &&
            !line.startsWith("@@") &&
            !line.startsWith("diff") &&
            !line.startsWith("+++ ") &&
            !line.startsWith("--- ")
        );
        if (kept.length > 0) {
          normalized = kept.join("\n");
        }
      }
    }
    return normalized.trimEnd();
  };

  const lines: string[] = [];
  lines.push("You are an AI coding assistant.");
  lines.push("Fix all issues listed below in this PR.");
  lines.push("Follow the project conventions and keep changes minimal.");
  lines.push("After fixes, update or add tests when appropriate.");
  lines.push("");
  lines.push("Issues:");
  comments.forEach((comment, idx) => {
    lines.push(
      `${idx + 1}. [${comment.severity}] ${comment.path}:${comment.line} (${comment.side}) - ${comment.title}`
    );
    lines.push(`Category: ${comment.category}`);
    lines.push(`Evidence: ${comment.evidence}`);
    lines.push(`Details: ${comment.body}`);
    if (comment.suggested_patch) {
      lines.push("Suggested patch:");
      lines.push(normalizeSuggestedPatch(comment.suggested_patch));
    }
    lines.push("");
  });

  return lines.join("\n");
}

function buildSummaryBlock(summary: ReviewOutput["summary"], comments: ReviewComment[]): string {
  const start = "<!-- grepiku-summary:start -->";
  const end = "<!-- grepiku-summary:end -->";
  const severityOrder = { blocking: 0, important: 1, nit: 2 } as const;
  const notable = [...comments].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  )[0];
  const keyConcerns =
    summary.key_concerns.length > 0
      ? summary.key_concerns.map((c) => `- ${c}`).join("\n")
      : "- (none)";
  const whatToTest =
    summary.what_to_test.length > 0
      ? summary.what_to_test.map((c) => `- ${c}`).join("\n")
      : "- (none)";

  const notableLine = notable
    ? `Notable issue: ${notable.title} (${notable.severity})`
    : "Notable issue: (none)";

  const fixPrompt = buildFixPrompt(comments);
  const escapeHtml = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  return [
    start,
    "## Grepiku Summary",
    "",
    "<details>",
    "<summary>Fix with AI</summary>",
    "",
    "<pre><code>",
    escapeHtml(fixPrompt),
    "</code></pre>",
    "</details>",
    "",
    summary.overview,
    "",
    `Risk: ${summary.risk}`,
    notableLine,
    "",
    "Key concerns:",
    keyConcerns,
    "",
    "What to test:",
    whatToTest,
    end
  ].join("\n");
}

function upsertSummaryBlock(body: string, block: string): string {
  const start = "<!-- grepiku-summary:start -->";
  const end = "<!-- grepiku-summary:end -->";
  const startIdx = body.indexOf(start);
  const endIdx = body.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = body.slice(0, startIdx).trimEnd();
    const after = body.slice(endIdx + end.length).trimStart();
    return [before, block, after].filter((part) => part.length > 0).join("\n\n");
  }
  const trimmed = body.trim();
  if (trimmed.length === 0) return block;
  return `${trimmed}\n\n${block}`;
}

export async function processReviewJob(data: ReviewJobData) {
  const { installationId, owner, repo, prNumber } = data;
  const octokit = getInstallationOctokit(installationId);
  const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const head = pr.data.head.sha;

  const repoInstallation = await prisma.repoInstallation.upsert({
    where: { installationId },
    update: { owner, repo },
    create: { installationId, owner, repo }
  });

  const pullRequest = await prisma.pullRequest.upsert({
    where: {
      repoInstallationId_number: {
        repoInstallationId: repoInstallation.id,
        number: prNumber
      }
    },
    update: {
      title: pr.data.title,
      url: pr.data.html_url,
      headSha: head,
      baseSha: pr.data.base.sha,
      state: pr.data.state
    },
    create: {
      repoInstallationId: repoInstallation.id,
      number: prNumber,
      title: pr.data.title,
      url: pr.data.html_url,
      headSha: head,
      baseSha: pr.data.base.sha,
      state: pr.data.state
    }
  });

  const run = await prisma.run.upsert({
    where: {
      pullRequestId_headSha: {
        pullRequestId: pullRequest.id,
        headSha: head
      }
    },
    update: {
      status: "running",
      startedAt: new Date()
    },
    create: {
      pullRequestId: pullRequest.id,
      headSha: head,
      status: "running",
      startedAt: new Date()
    }
  });

  await upsertStatusComment({
    octokit,
    owner,
    repo,
    prNumber,
    pullRequestId: pullRequest.id,
    body: renderReviewingComment()
  });

  try {
    const installationToken = await getInstallationToken(installationId);
    const repoPath = await ensureRepoCheckout({
      installationToken,
      owner,
      repo,
      headSha: head
    });

    const repoConfig = await loadRepoConfig(repoPath);
    let diffPatch: string;
    try {
      diffPatch = await fetchDiffPatch(octokit, owner, repo, prNumber);
    } catch (err) {
      if (!isDiffTooLargeError(err)) throw err;
      diffPatch = await buildLocalDiffPatch({
        repoPath,
        baseSha: pr.data.base.sha,
        headSha: head
      });
    }
    const changedFiles = await listChangedFiles(octokit, owner, repo, prNumber);

    const prMarkdown = renderPrMarkdown({
      title: pr.data.title,
      number: prNumber,
      author: pr.data.user?.login || "unknown",
      body: pr.data.body,
      baseRef: pr.data.base.ref,
      headRef: pr.data.head.ref,
      headSha: head,
      url: pr.data.html_url
    });

    const { bundleDir, outDir, codexHomeDir } = await createRunDirs(env.projectRoot, run.id);
    await writeBundleFiles({
      bundleDir,
      prMarkdown,
      diffPatch,
      changedFiles,
      repoConfig
    });

    const reviewerPrompt = buildReviewerPrompt(repoConfig);
    await runCodexStage({
      stage: "reviewer",
      repoPath,
      bundleDir,
      outDir,
      codexHomeDir,
      prompt: reviewerPrompt,
      headSha: head,
      repoInstallationId: repoInstallation.id,
      prNumber
    });

    const draft = await readAndValidateJson(path.join(outDir, "draft_review.json"), ReviewSchema);

    const editorPrompt = buildEditorPrompt(
      JSON.stringify(draft, null, 2),
      diffPatch
    );
    await runCodexStage({
      stage: "editor",
      bundleDir,
      outDir,
      codexHomeDir,
      prompt: editorPrompt,
      headSha: head,
      repoInstallationId: repoInstallation.id,
      prNumber
    });

    const finalReview = await readAndValidateJson(
      path.join(outDir, "final_review.json"),
      ReviewSchema
    );
    const verdicts = await readAndValidateJson(path.join(outDir, "verdicts.json"), VerdictsSchema);

    const diffIndex = buildDiffIndex(diffPatch);
    const verdictMap = new Map(verdicts.verdicts.map((v) => [v.comment_id, v]));
    const commentsAfterVerdict: ReviewComment[] = [];
    for (const comment of finalReview.comments) {
      const verdict = verdictMap.get(comment.comment_id);
      if (verdict?.decision === "drop") continue;
      if (verdict?.decision === "revise" && verdict.revised_comment) {
        const revised = ReviewCommentSchema.safeParse(verdict.revised_comment);
        if (revised.success) {
          commentsAfterVerdict.push(revised.data);
          continue;
        }
      }
      commentsAfterVerdict.push(comment);
    }

    const filteredComments = filterAndNormalizeComments(
      { ...finalReview, comments: commentsAfterVerdict },
      diffIndex,
      repoConfig.limits.max_inline_comments,
      repoConfig.ignore
    );

    const summaryBlock = buildSummaryBlock(finalReview.summary, filteredComments);
    const originalBody = pr.data.body || "";
    const updatedBody = upsertSummaryBlock(originalBody, summaryBlock);
    if (updatedBody !== originalBody) {
      await octokit.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        body: updatedBody
      });
    }

    const checksPrompt = buildVerifierPrompt(head);
    await runCodexStage({
      stage: "verifier",
      repoPath,
      bundleDir,
      outDir,
      codexHomeDir,
      prompt: checksPrompt,
      headSha: head,
      repoInstallationId: repoInstallation.id,
      prNumber
    });
    const checksPath = path.join(outDir, "checks.json");
    let checks: ChecksOutput;
    try {
      checks = await readAndValidateJson(checksPath, ChecksSchema);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      const lastMessagePath = path.join(outDir, "last_message.txt");
      const lastMessage = await fs.readFile(lastMessagePath, "utf8").catch(() => "");
      if (!lastMessage.trim()) throw err;
      checks = parseAndValidateJson(lastMessage, ChecksSchema);
    }

    const existingOpen = await prisma.finding.findMany({
      where: {
        pullRequestId: pullRequest.id,
        status: "open"
      }
    });

    const existingByKey = new Map<string, typeof existingOpen[number]>();
    for (const finding of existingOpen) {
      const key = `${finding.fingerprint}|${finding.path}|${finding.hunkHash}|${finding.title}`;
      existingByKey.set(key, finding);
    }

    const newFindings: Array<{ title: string; url?: string; commentId: string }> = [];
    const stillOpen: Array<{ title: string; url?: string; commentId: string }> = [];
    const matchedOldIds = new Set<number>();

    const reviewComments = filteredComments;
    for (const comment of reviewComments) {
      const hunkHash = hunkHashForComment(diffIndex, comment);
      const contextHash = contextHashForComment(diffIndex, comment);
      const fingerprint = fingerprintForComment(comment);
      const matchKey = matchKeyForComment(comment, hunkHash);
      const existing = existingByKey.get(matchKey);

      if (existing) {
        matchedOldIds.add(existing.id);
        stillOpen.push({ title: comment.title, commentId: comment.comment_id });
        await prisma.finding.update({
          where: { id: existing.id },
          data: {
            status: "open",
            lastSeenRunId: run.id,
            body: comment.body,
            evidence: comment.evidence,
            suggestedPatch: comment.suggested_patch
          }
        });
        continue;
      }

      newFindings.push({ title: comment.title, commentId: comment.comment_id });
      await prisma.finding.create({
        data: {
          pullRequestId: pullRequest.id,
          runId: run.id,
          status: "open",
          fingerprint,
          hunkHash,
          contextHash,
          commentId: comment.comment_id,
          commentKey: comment.comment_key,
          path: comment.path,
          line: comment.line,
          side: comment.side,
          severity: comment.severity,
          category: comment.category,
          title: comment.title,
          body: comment.body,
          evidence: comment.evidence,
          suggestedPatch: comment.suggested_patch,
          firstSeenRunId: run.id,
          lastSeenRunId: run.id
        }
      });
    }

    const fixed = existingOpen.filter((f) => !matchedOldIds.has(f.id));
    for (const finding of fixed) {
      const isObsolete = !diffIndex.files.has(normalizePath(finding.path));
      await prisma.finding.update({
        where: { id: finding.id },
        data: { status: isObsolete ? "obsolete" : "fixed", lastSeenRunId: run.id }
      });
    }

    const newCommentIds = new Set(newFindings.map((f) => f.commentId));
    const commentsToPost = reviewComments.filter((c) => newCommentIds.has(c.comment_id));
    let reviewResponse = null as null | { comments: Array<{ id: number; body: string }> };
    if (commentsToPost.length > 0) {
      const review = await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: head,
        event: "COMMENT",
        comments: commentsToPost.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side as "RIGHT" | "LEFT",
          body: formatInlineComment(comment)
        }))
      });

      const reviewComments = ((review.data as unknown as { comments?: Array<{ id: number; body?: string | null }> }).comments || []);
      reviewResponse = {
        comments: reviewComments.map((c) => ({ id: c.id, body: c.body || "" }))
      };
    }

    if (reviewResponse) {
      for (const comment of reviewResponse.comments) {
        const commentId = extractCommentId(comment.body);
        if (!commentId) continue;
        await prisma.finding.updateMany({
          where: {
            pullRequestId: pullRequest.id,
            commentId
          },
          data: {
            githubCommentId: String(comment.id)
          }
        });
      }
    }

    // Sync existing review comments to ensure formatting stays current
    const allReviewComments = await octokit.paginate(
      octokit.pulls.listReviewComments,
      { owner, repo, pull_number: prNumber, per_page: 100 }
    );
    const byMarker = new Map<string, { id: number; body?: string | null }>();
    for (const rc of allReviewComments) {
      const marker = extractCommentId(rc.body || "");
      if (marker) {
        byMarker.set(marker, { id: rc.id, body: rc.body });
      }
    }
    for (const comment of reviewComments) {
      const existing = byMarker.get(comment.comment_id);
      if (!existing) continue;
      const desiredBody = formatInlineComment(comment);
      if ((existing.body || "") !== desiredBody) {
        await octokit.pulls.updateReviewComment({
          owner,
          repo,
          comment_id: existing.id,
          body: desiredBody
        });
      }
      await prisma.finding.updateMany({
        where: {
          pullRequestId: pullRequest.id,
          commentId: comment.comment_id
        },
        data: {
          githubCommentId: String(existing.id)
        }
      });
    }

    const updatedOpen = await prisma.finding.findMany({
      where: {
        pullRequestId: pullRequest.id,
        status: "open"
      }
    });

    const makeCommentUrl = (commentId?: string | null) => {
      if (!commentId) return undefined;
      return `https://github.com/${owner}/${repo}/pull/${prNumber}#discussion_r${commentId}`;
    };

    const newFindingLinks = newFindings.map((f) => ({
      title: f.title,
      url: makeCommentUrl(
        updatedOpen.find((o) => o.commentId === f.commentId)?.githubCommentId || null
      )
    }));

    const openFindingLinks = stillOpen.map((f) => ({
      title: f.title,
      url: makeCommentUrl(
        updatedOpen.find((o) => o.commentId === f.commentId)?.githubCommentId || null
      )
    }));

    const fixedFindingLinks = fixed.map((f) => ({ title: f.title }));

    const statusBody = renderStatusComment({
      summary: finalReview.summary,
      newFindings: newFindingLinks,
      openFindings: openFindingLinks,
      fixedFindings: fixedFindingLinks,
      checks: checks.checks
    });

    await upsertStatusComment({
      octokit,
      owner,
      repo,
      prNumber,
      pullRequestId: pullRequest.id,
      body: statusBody
    });

    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        draftJson: draft,
        finalJson: finalReview,
        verdictsJson: verdicts,
        checksJson: checks
      }
    });
  } catch (err) {
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "failed", completedAt: new Date() }
    });
    throw err;
  }
}
