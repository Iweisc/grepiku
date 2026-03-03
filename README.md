# Grepiku

GitHub PR review bot powered by Codex.

## What It Does

- Handles GitHub PR, comment, review-comment, and reaction webhooks
- Runs auto reviews on PR updates plus manual `/review` triggers
- Applies trigger filters for labels, branches, authors, keywords, and manual-only mode
- Executes a 3-stage Codex pipeline: reviewer, editor, execution verifier
- Runs a supplemental coverage pass when changed-file coverage is low
- Posts inline comments plus a status summary comment
- Creates/updates GitHub check-runs and can make blocking findings fail required checks
- Tracks finding lifecycle across pushes: `new`, `open`, `fixed`, `obsolete`
- Auto-resolves fixed inline review threads when provider permissions allow
- Syncs a "Grepiku Summary" block into the PR body (with optional incremental update control)
- Mention workflow:
  - `@grepiku ...` Q&A replies on PR comment threads
  - `@grepiku do: ...` implementation path that commits code to a bot branch and opens a follow-up PR
- Runs repo-configured lint/build/test checks for mention `do:` changes and drafts the follow-up PR when checks fail
- Learns from reviewer reactions/replies:
  - feedback-aware prioritization
  - per-category/per-rule adaptive weights
  - auto-generated rule suggestions
- Stores "team preference" memory suggestions from comment directives (e.g. remember/avoid/always), reviewable in dashboard
- Local-first diff and changed-file collection via git worktree checkout, with provider API fallback
- First PR bootstrap: full-codebase index + graph build when repo has no prior index
- First completed review run includes a one-time full-repo static audit mode
- Vectorless indexing of files/symbols/chunks (Tree-sitter + import/export reference extraction)
- Graph builder for file/symbol/module/directory relationships and dependency traversal
- Hybrid retrieval with PageIndex scoring + lexical fallback + RRF + path/directory/kind boosts
- Pattern repository indexing and retrieval boosts for reusable standards/examples
- Dashboard analytics (reviews, traversal quality, findings, weights, rule suggestions)
- Optional MCP IDE server with tools for comments/findings/patterns/standards/reports

## Architecture

- Fastify webhook server
- BullMQ workers:
  - `review-orchestrator`
  - `mention-replies`
  - `indexer`
  - `graph-builder`
  - `analytics-ingest`
- Postgres for state
- Redis for queue
- Direct `codex-exec` integration from `internal_harness/codex-slim`
- Optional MCP stdio server (`start:mcp-ide`)

## Requirements

- Docker + docker-compose
- Node.js 20+

## Setup

1) Create a GitHub App
- Permissions (minimum):
  - Pull requests: read & write
  - Issues: read & write
  - Reactions: write
  - Contents: read
  - Checks: read
- For `@grepiku do:` follow-up PR creation, use:
  - Contents: read & write
  - Pull requests: read & write
- Subscribe to webhook events:
  - `pull_request`, `issue_comment`, `pull_request_review_comment`, `reaction`

Important:
- `pull_request_review_comment` is required for replies on inline review threads.
- After changing webhook subscriptions or permissions, re-install/update the GitHub App on the target repo/org so changes take effect.

2) Configure environment

Copy `.env.example` to `.env` and set values. `PROJECT_ROOT` must be an absolute path to this repo.
Additional vars:
- `INTERNAL_API_KEY` (required for internal APIs and retrieval tool access)
- `CODEX_EXEC_PATH` (path to `codex-exec`; Docker worker uses `/usr/local/bin/codex-exec`)
- `INTERNAL_API_KEY` is also used for dashboard auth (Basic or Bearer token)

3) Start services

```bash
docker compose up -d postgres redis
npm install
npm run prisma:generate
npm run prisma:migrate
docker compose up -d --build web worker
```

## Repo Configuration

Preferred `grepiku.json` in repo root (legacy `greptile.json` and `.prreviewer.yml` still supported):

```yaml
{
  "ignore": ["node_modules/**", "dist/**"],
  "graph": {
    "exclude_dirs": ["internal_harness"],
    "traversal": {
      "max_depth": 5,
      "min_score": 0.07,
      "max_related_files": 28,
      "max_graph_links": 110,
      "hard_include_files": 8,
      "max_nodes_visited": 2600
    }
  },
  "tools": {
    "lint": { "cmd": "pnpm lint", "timeout_sec": 900 },
    "build": { "cmd": "pnpm build", "timeout_sec": 1200 },
    "test": { "cmd": "pnpm test -- --ci", "timeout_sec": 1800 }
  },
  "limits": { "max_inline_comments": 20, "max_key_concerns": 5 },
  "rules": [],
  "scopes": [],
  "patternRepositories": [],
  "strictness": "medium",
  "commentTypes": { "allow": ["inline", "summary"] },
  "output": {
    "summaryOnly": false,
    "destination": "comment",
    "syncSummaryWithStatus": true,
    "allowIncrementalPrBodyUpdates": true
  },
  "retrieval": {
    "topK": 28,
    "maxPerPath": 6,
    "semanticWeight": 0.62,
    "lexicalWeight": 0.22,
    "rrfWeight": 0.08,
    "changedPathBoost": 0.16,
    "sameDirectoryBoost": 0.08,
    "patternBoost": 0.03,
    "symbolBoost": 0.02,
    "chunkBoost": 0.03
  },
  "statusChecks": { "name": "Grepiku Review", "required": false },
  "triggers": {
    "manualOnly": false,
    "allowAutoOnPush": true,
    "labels": { "include": [], "exclude": [] },
    "branches": { "include": [], "exclude": [] },
    "authors": { "include": [], "exclude": [] },
    "keywords": { "include": [], "exclude": [] },
    "commentTriggers": ["/review", "@grepiku"]
  }
}
```

`graph.exclude_dirs` is a list of repo-relative directory prefixes excluded from graph generation and graph traversal seeding (indexing and retrieval remain unchanged).  
`graph.traversal` tunes how aggressively graph traversal expands context during review.
`retrieval` now uses a vectorless PageIndex tree search over file/symbol/chunk nodes; `semanticWeight` and `lexicalWeight` tune node-title vs node-content relevance in that scorer.
`output.syncSummaryWithStatus` keeps the PR body "Grepiku Summary" synchronized with each AI review status run (default: `true`).  
`output.allowIncrementalPrBodyUpdates` allows PR body summary updates on incremental/synchronize runs (default: `true`).
Scoped per-path overrides are supported via `.grepiku/config.json` files (for `strictness`, `commentTypes`, `ignore`, `limits`, and `rules`).

If missing, defaults are used and tools are marked as skipped.

## Runtime Notes

- Each run writes artifacts under `var/runs/<runId>`.
- Worker executes `codex-exec` directly and injects MCP roots for repo/bundle/out paths.
- Review and mention pipelines are local-first: diff/changed-file context is computed from local git checkout by default, with GitHub API as fallback.
- Review and mention-reply workloads run on separate BullMQ queues, so `@grepiku` Q&A / `do:` jobs do not wait behind long PR review runs.
- When changed-file coverage is low, Grepiku runs a supplemental coverage pass focused on uncovered changed files to improve bug recall.
- On PR close, queued review jobs are cancelled and outcome signals are applied to finding weights.
- Bot-authored/suggestion-only push scenarios are filtered to avoid noisy self-reviews.
- Worker concurrency can be tuned with:
  - `REVIEW_WORKER_CONCURRENCY` (default `3`)
  - `MENTION_WORKER_CONCURRENCY` (default `3`)
- Tool runs are cached in Postgres per (review run, tool).

## Endpoints

- Public:
  - `POST /webhooks` GitHub App webhook receiver
  - `GET /healthz` health check
- Dashboard (auth via `INTERNAL_API_KEY`):
  - `GET /dashboard`
  - `GET /dashboard/repo/:id`
  - `GET /api/repos`
  - `GET /api/repos/:id/graph`
  - `GET /api/reviews/recent`
  - `GET /api/analytics/summary`
  - `GET /api/analytics/traversal`
  - `GET /api/analytics/insights`
  - `GET /api/analytics/findings-by-severity`
  - `GET /api/analytics/weights`
  - `GET /api/analytics/export`
  - `GET /api/rules/suggestions`
  - `POST /api/rules/suggestions/:id/approve`
  - `POST /api/rules/suggestions/:id/reject`
- Internal API (auth via `INTERNAL_API_KEY`):
  - `POST /internal/review/enqueue`
  - `POST /internal/index/enqueue`
  - `POST /internal/rules/resolve`
  - `POST /internal/retrieval`
  - `POST /internal/triggers/update`

## Development

Run the server and worker locally:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev:server
npm run dev:worker
```

Useful targeted worker scripts:

```bash
npm run dev:review-worker
npm run dev:indexer
npm run dev:graph
npm run dev:analytics
```

## PageIndex Migration

To migrate existing indexed repos to the new PageIndex retrieval model:

```bash
npm run migrate:pageindex
```

Use `--dry-run` first to preview impact:

```bash
npm run migrate:pageindex -- --dry-run
```

## Overnight Loop

Run repeated manual review cycles with automatic retrieval tuning:

```bash
REVIEW_LOOP_REPO_FULL_NAME=owner/repo \
REVIEW_LOOP_PR_NUMBER=123 \
REVIEW_LOOP_MAX_CYCLES=40 \
npm run start:review-loop
```

Cycle logs are written to `var/loop/*.jsonl`.

## Traversal Quality Loop

Replay evaluator over historical completed runs:

```bash
npm run check:traversal-quality
```

Optional filters and thresholds:

```bash
tsx src/tools/traversalQuality.ts --ci --replay --repo-id=2 --since-days=14 --limit=500 --concurrency=4
```

The command exits non-zero in `--ci` mode when recall/precision or p95 SLO thresholds are violated.

## Optional Tools

- MCP IDE server:

```bash
npm run start:mcp-ide
```

- Local demo review runner (without webhook flow):

```bash
npm run start:demo -- --repo-path /absolute/path/to/repo
```
