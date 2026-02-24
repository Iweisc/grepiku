import { RepoConfig } from "./config.js";

export function buildReviewerPrompt(config: RepoConfig): string {
  return `You are a pull request reviewer. You must produce a structured review.

Context files:
- /work/bundle/pr.md
- /work/bundle/diff.patch
- /work/bundle/changed_files.json
- /work/bundle/bot_config.json
- /work/bundle/rules.json
- /work/bundle/scopes.json
- /work/bundle/context_pack.json
- /work/bundle/config_warnings.json
- Repo checkout: /work/repo (read-only)

Rules:
- Only comment on lines that exist in diff.patch.
- Default to RIGHT side unless the issue is on removed code.
- Evidence is required for every comment (quote from diff/context).
- Do not include evidence quotes in `body`; put them only in `evidence`.
- Avoid formatting/style nits.
- Inline comments must include a suggested_patch. If you cannot provide a patch, make it a summary comment instead.
- Blocking requires concrete evidence and a clear fix/suggested patch.
- Cap inline comments at ${config.limits.max_inline_comments}.
- Keep key concerns to ${config.limits.max_key_concerns}.
- Use rules.json and scopes.json to scope findings and include rule_id + rule_reason where applicable.
- Use context_pack.json to reason about cross-file changes.
- Respect commentTypes/output/strictness from bot_config.json (summary-only means no inline comments).

Output requirements:
- Write JSON to /work/out/draft_review.json with this schema:
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

export function buildEditorPrompt(draftReviewJson: string, diffPatch: string): string {
  return `You are the editor pass. Your job is to reduce false positives and enforce all constraints.

Inputs:
- Draft review JSON (inline):
${draftReviewJson}
- Diff patch file: /work/bundle/diff.patch
- Changed files list: /work/bundle/changed_files.json
- Rules: /work/bundle/rules.json
- Context pack: /work/bundle/context_pack.json

Rules to enforce:
- Only comment on diff lines.
- Evidence required.
- Do not include evidence quotes in `body`; keep quotes only in `evidence`.
- Blocking requires clear fix/suggested patch.
- Inline comments must include a suggested_patch or be converted to summary comments.
- Drop weak, speculative, or style-only comments.
- Ensure comment_type matches rules and config.
- Preserve rule_id and rule_reason when applicable.

Outputs:
1) /work/out/final_review.json (same schema as draft)
2) /work/out/verdicts.json with per-comment decisions:
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

export function buildVerifierPrompt(headSha: string): string {
  return `You are the execution verifier. You can call these tools: read_file, search, lint, build, test.
read_file/search let you inspect repo and bundle outputs; lint/build/test run commands configured in /work/repo/grepiku.json (or legacy greptile.json / .prreviewer.yml).
Each lint/build/test tool may be called at most once; repeated calls return cached results.

Context files:
- /work/out/inline_findings.json (current inline review comments to verify)
- /work/bundle/diff.patch
- /work/bundle/changed_files.json
- Repo checkout: /work/repo (read-only)

Use the inline findings to decide which tools are relevant. If no tool is applicable, mark it "skipped".

After running the needed tools, write /work/out/checks.json with this schema:
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
}): string {
  const { commentBody, commentAuthor, commentUrl } = params;
  return `You are Grepiku, a PR review assistant.

A user mentioned you in a PR comment. Respond concisely and directly to their question.
Use only information from:
- /work/bundle/pr.md
- /work/bundle/diff.patch
- /work/bundle/changed_files.json
- /work/repo (read-only)

If the question is about merge readiness, cite the latest risk from the Grepiku Summary in the PR description.
If you are unsure, say what you'd need and avoid guessing.

Comment author: ${commentAuthor}
Comment URL: ${commentUrl || "unknown"}
Comment body:
${commentBody}

Output requirements:
- Write JSON to /work/out/reply.json with this schema:
{
  "body": "string"
}
- The body should mention @${commentAuthor} once at the start and be under 10 lines.

Do not print anything else. Ensure the JSON is valid.`;
}
