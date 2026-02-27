import { RepoConfig } from "./config.js";

export type PromptPaths = {
  repoPath: string;
  bundleDir: string;
  outDir: string;
};

export type ReviewPromptOptions = {
  fullRepoStaticAudit?: boolean;
};

function bundlePath(paths: PromptPaths, file: string): string {
  return `${paths.bundleDir}/${file}`;
}

function outPath(paths: PromptPaths, file: string): string {
  return `${paths.outDir}/${file}`;
}

export function buildReviewerPrompt(config: RepoConfig, paths: PromptPaths, options: ReviewPromptOptions = {}): string {
  const scopeRules = options.fullRepoStaticAudit
    ? [
        "- This is the first completed review for this PR. Perform a one-time full repository static audit against the current checkout.",
        "- Inline comments must still target lines that exist in diff.patch.",
        '- You may include findings outside diff.patch only as `comment_type: "summary"`.'
      ]
    : ["- Only comment on lines that exist in diff.patch."];
  return `You are a pull request reviewer. You must produce a structured review.

Context files:
- ${bundlePath(paths, "pr.md")}
- ${bundlePath(paths, "diff.patch")}
- ${bundlePath(paths, "changed_files.json")}
- ${bundlePath(paths, "bot_config.json")}
- ${bundlePath(paths, "rules.json")}
- ${bundlePath(paths, "scopes.json")}
- ${bundlePath(paths, "context_pack.json")}
- ${bundlePath(paths, "config_warnings.json")}
- Repo checkout: ${paths.repoPath} (read-only)

Rules:
${scopeRules.join("\n")}
- Default to RIGHT side unless the issue is on removed code.
- Evidence is required for every comment (quote from diff/context).
- Do not include evidence quotes in body; put them only in evidence.
- Avoid formatting/style nits.
- Prioritize correctness, security, performance regressions, API contract breaks, and missing tests.
- Use context_pack.json (reviewFocus, hotspots, graphLinks, graphPaths, graphDebug, retrieved) to reason about cross-file impact.
- Avoid duplicate findings: one comment per root cause.
- Keep inline comments concentrated on highest-impact issues; avoid flooding a single file.
- Inline comments must include a suggested_patch. If you cannot provide a patch, make it a summary comment instead.
- Blocking requires concrete evidence and a clear fix/suggested patch.
- Cap inline comments at ${config.limits.max_inline_comments}.
- Keep key concerns to ${config.limits.max_key_concerns}.
- Use rules.json and scopes.json to scope findings and include rule_id + rule_reason where applicable.
- Use context_pack.json to reason about cross-file changes.
- Respect commentTypes/output/strictness from bot_config.json (summary-only means no inline comments).
- Set confidence explicitly for every comment; low-confidence issues should usually be summary or omitted.

Output requirements:
- Write JSON to ${outPath(paths, "draft_review.json")} with this schema:
{
  "summary": {
    "overview": "string",
    "risk": "low|medium|high",
    "confidence": 0.0,
    "key_concerns": ["string"],
    "what_to_test": ["string"],
    "file_breakdown": [
      { "path": "string", "summary": "string", "risk": "low|medium|high (optional)" }
    ],
    "diagram_mermaid": "string (optional)"
  },
  "comments": [
    {
      "comment_id": "string",
      "comment_key": "string",
      "path": "string",
      "side": "RIGHT|LEFT",
      "line": 123,
      "severity": "blocking|important|nit",
      "category": "bug|security|performance|maintainability|testing|style",
      "title": "string",
      "body": "string",
      "evidence": "string",
      "suggested_patch": "string (optional)",
      "comment_type": "inline|summary (optional)",
      "rule_id": "string (optional)",
      "rule_reason": "string (optional)",
      "confidence": "high|medium|low (optional)"
    }
  ]
}

Do not print anything else to stdout. Ensure the JSON is valid.`;
}

export function buildEditorPrompt(
  draftReviewJson: string,
  paths: PromptPaths,
  options: ReviewPromptOptions = {}
): string {
  const placementRules = options.fullRepoStaticAudit
    ? [
        "- Inline comments must be on diff lines.",
        '- Summary comments may cover issues outside diff.patch when they are high-confidence and actionable.'
      ]
    : ["- Only comment on diff lines."];
  return `You are the editor pass. Your job is to reduce false positives and enforce all constraints.

Inputs:
- Draft review JSON (inline):
${draftReviewJson}
- Diff patch file: ${bundlePath(paths, "diff.patch")}
- Changed files list: ${bundlePath(paths, "changed_files.json")}
- Rules: ${bundlePath(paths, "rules.json")}
- Context pack: ${bundlePath(paths, "context_pack.json")}

Rules to enforce:
${placementRules.join("\n")}
- Evidence required.
- Do not include evidence quotes in body; keep quotes only in evidence.
- Blocking requires clear fix/suggested patch.
- Inline comments must include a suggested_patch or be converted to summary comments.
- Drop weak, speculative, or style-only comments.
- Remove duplicate or overlapping comments that point to the same root cause.
- Keep strongest findings first and trim lower-value repeats in the same file.
- Ensure comment_type matches rules and config.
- Preserve rule_id and rule_reason when applicable.

Outputs:
1) ${outPath(paths, "final_review.json")} (same schema as draft)
2) ${outPath(paths, "verdicts.json")} with per-comment decisions:
{
  "verdicts": [
    {
      "comment_id": "string",
      "decision": "keep|revise|drop",
      "confidence": "high|medium|low",
      "reason": "string",
      "revised_comment": { }
    }
  ]
}

Do not print anything else. Ensure valid JSON files.`;
}

export function buildVerifierPrompt(headSha: string, paths: PromptPaths): string {
  return `You are the execution verifier. You can call these tools: read_file, search, lint, build, test.
read_file/search let you inspect repo and bundle outputs; lint/build/test run commands configured in ${paths.repoPath}/grepiku.json (or legacy greptile.json / .prreviewer.yml).
Each lint/build/test tool may be called at most once; repeated calls return cached results.

Context files:
- ${outPath(paths, "inline_findings.json")} (current inline review comments to verify)
- ${bundlePath(paths, "diff.patch")}
- ${bundlePath(paths, "changed_files.json")}
- Repo checkout: ${paths.repoPath} (read-only)

Use the inline findings to decide which tools are relevant. If no tool is applicable, mark it "skipped".

After running the needed tools, write ${outPath(paths, "checks.json")} with this schema:
{
  "head_sha": "${headSha}",
  "checks": {
    "lint": { "status": "pass|fail|timeout|skipped|error", "summary": "string", "top_errors": ["string"] },
    "build": { "status": "pass|fail|timeout|skipped|error", "summary": "string", "top_errors": ["string"] },
    "test": { "status": "pass|fail|timeout|skipped|error", "summary": "string", "top_errors": ["string"] }
  }
}

Do not print anything else. Ensure valid JSON.`;
}

export function buildMentionPrompt(params: {
  commentBody: string;
  commentAuthor: string;
  commentUrl?: string;
  repoPath: string;
  bundleDir: string;
  outDir: string;
}): string {
  const { commentBody, commentAuthor, commentUrl, repoPath, bundleDir, outDir } = params;
  return `You are Grepiku, a PR review assistant.

A user mentioned you in a PR comment. Respond concisely and directly to their question.
Use only information from:
- ${bundleDir}/pr.md
- ${bundleDir}/diff.patch
- ${bundleDir}/changed_files.json
- ${repoPath} (read-only)

If the question is about merge readiness, cite the latest risk from the Grepiku Summary in the PR description.
If you are unsure, say what you'd need and avoid guessing.

Comment author: ${commentAuthor}
Comment URL: ${commentUrl || "unknown"}
Comment body:
${commentBody}

Output requirements:
- Write JSON to ${outDir}/reply.json with this schema:
{
  "body": "string"
}
- The body should mention @${commentAuthor} once at the start and be under 10 lines.

Do not print anything else. Ensure the JSON is valid.`;
}

export function buildMentionImplementPrompt(params: {
  commentBody: string;
  commentAuthor: string;
  commentUrl?: string;
  task: string;
  repoPath: string;
  bundleDir: string;
  outDir: string;
}): string {
  const { commentBody, commentAuthor, commentUrl, task, repoPath, bundleDir, outDir } = params;
  return `You are Grepiku, a coding agent working on a pull-request follow-up task.

Implement the requested change directly in the repository checkout.
Requested task:
${task}

Source context:
- ${bundleDir}/pr.md
- ${bundleDir}/diff.patch
- ${bundleDir}/changed_files.json
- ${bundleDir}/context_pack.json
- Repo checkout: ${repoPath} (writable)

Rules:
- Make the smallest correct set of code changes needed for the request.
- If the request is unclear, unsafe, or not feasible, do not guess.
- Do not run git commit, git push, or open PRs yourself.
- Keep edits in the repository checkout only.

Comment author: ${commentAuthor}
Comment URL: ${commentUrl || "unknown"}
Original comment body:
${commentBody}

Output requirements:
- Write JSON to ${outDir}/mention_action.json with this schema:
{
  "action": "changed|no_changes|cannot_complete",
  "summary": "string",
  "reply": "string",
  "commit_message": "string (optional)",
  "pr_title": "string (optional)",
  "pr_body": "string (optional)"
}
- reply must start with @${commentAuthor}.
- If no code changes were needed, set action=no_changes.
- If blocked or unclear, set action=cannot_complete and explain briefly in reply.

Do not print anything else. Ensure the JSON is valid.`;
}

export function buildMentionVerifyPrompt(params: {
  repoPath: string;
  outDir: string;
}): string {
  const { repoPath, outDir } = params;
  return `You are the verifier for mention-requested code changes.
You can call these tools: lint, build, test.
Each tool can be called at most once; repeated calls return cached results.

Run only relevant tools. If a tool is not configured in repo config, it will be marked skipped.
Repo checkout: ${repoPath}

Write ${outDir}/mention_checks.json with this schema:
{
  "checks": {
    "lint": { "status": "pass|fail|timeout|skipped|error", "summary": "string", "top_errors": ["string"] },
    "build": { "status": "pass|fail|timeout|skipped|error", "summary": "string", "top_errors": ["string"] },
    "test": { "status": "pass|fail|timeout|skipped|error", "summary": "string", "top_errors": ["string"] }
  }
}

Do not print anything else. Ensure valid JSON.`;
}
