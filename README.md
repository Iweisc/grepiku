# Grepiku

Grepiku is a GitHub PR review bot powered by Codex.

The short version: it reviews pull requests like a teammate, stays with the PR across pushes, answers questions in-thread, can turn `@grepiku do: ...` into a follow-up PR, and keeps getting sharper as your team reacts to its comments.

## Why Grepiku is interesting

Most review bots stop at "here are some comments on this diff."

Grepiku is trying to do something bigger:

- review the code with real repo context, not just the patch
- track findings across pushes so the review evolves with the PR
- let developers talk to the bot in the thread instead of leaving the GitHub flow
- learn from reviewer feedback, team preferences, and rule decisions
- surface what is happening in a dashboard instead of hiding everything in logs

## What it can do

### Review like a teammate

- Handles GitHub PR, comment, review-comment, and reaction webhooks
- Runs automatic reviews on PR updates and manual reviews from `/review`
- Uses a 3-stage pipeline: reviewer, editor, execution verifier
- Runs a supplemental coverage pass when changed-file coverage is low
- Posts inline comments plus a status summary comment
- Creates and updates GitHub check-runs, including blocking outcomes when configured

### Stay with the PR across pushes

- Tracks findings through `new`, `open`, `fixed`, and `obsolete`
- Auto-resolves fixed inline review threads when provider permissions allow
- Syncs a "Grepiku Summary" block into the PR body
- Supports incremental whole-PR review updates instead of treating every push like a brand-new conversation

### Work inside the conversation

- `@grepiku ...` answers questions inside PR threads
- `@grepiku do: ...` can take an implementation request, commit code to a bot branch, and open a follow-up PR
- Mention-driven implementation runs repo-configured `lint`, `build`, and `test` checks
- If checks fail, Grepiku drafts the follow-up PR with the failure context instead of pretending everything is fine

### Learn what your team cares about

- Uses reactions and replies to adjust prioritization over time
- Maintains adaptive weights by category and rule
- Generates review rule suggestions from observed feedback
- Stores team preference memory suggestions from comment directives like `remember`, `avoid`, or `always`
- Exposes those decisions in the dashboard so the learning loop is inspectable

### Understand the codebase, not just the patch

- Local-first diff and changed-file collection via git worktrees, with provider API fallback
- First-PR bootstrap path that builds a full codebase index and graph when needed
- First completed review includes a one-time full-repo static audit mode
- Vectorless indexing of files, symbols, and chunks using Tree-sitter plus reference extraction
- Graph traversal over file, symbol, module, and directory relationships
- Graphify-backed PR review context expansion from changed files into related code paths
- Hybrid retrieval with PageIndex scoring, lexical fallback, RRF, and path-aware boosts
- Pattern repository indexing and retrieval boosts for reusable standards and examples

### Show its work

- Dashboard analytics for reviews, traversal quality, findings, weights, and rule suggestions
- Optional MCP IDE server with tools for comments, findings, patterns, standards, and reports
- Per-run artifacts under `var/runs/<runId>` so reviews are debuggable instead of opaque

## A typical Grepiku workflow

1. A PR opens or gets a new push.
2. Grepiku reviews it automatically and posts inline findings plus a summary.
3. The author pushes fixes.
4. Grepiku updates the review, marks fixed findings as fixed, and can resolve old threads.
5. A teammate asks `@grepiku why is this risky?` in the thread.
6. Grepiku answers in context.
7. Someone says `@grepiku do: add the missing retry logic`.
8. Grepiku makes the change on a bot branch, runs checks, and opens a follow-up PR.
9. Reviewer reactions and replies feed back into future prioritization.

That is the core idea: review, conversation, implementation, and learning all in one loop.

## What makes it different from a basic PR bot

| Basic bot | Grepiku |
| --- | --- |
| One-shot diff comments | Multi-stage review pipeline with reviewer, editor, and verifier |
| Stateless between pushes | Tracks finding lifecycle across the whole PR |
| Separate bot for Q&A | Q&A happens directly in the PR thread with `@grepiku` |
| No action path | `@grepiku do:` can produce code and a follow-up PR |
| Flat diff-only context | Uses indexing, graph traversal, and hybrid retrieval |
| Fixed rules forever | Learns from reactions, replies, and rule approval decisions |
| Hidden internals | Dashboard analytics and persisted run artifacts |

## Architecture at a glance

- Fastify webhook server
- BullMQ workers:
  - `review-orchestrator`
  - `mention-replies`
  - `indexer`
  - `graph-builder`
  - `analytics-ingest`
- Postgres for state
- Redis for queueing
- Direct `codex-exec` integration from `internal_harness/codex-slim`
- Optional MCP stdio server (`start:mcp-ide`)

## Requirements

- Docker + docker-compose
- Node.js 20+

## Setup

### 1) Create a GitHub App

Permissions required by the current implementation:

- Pull requests: read & write
- Issues: read & write
- Contents: read & write
- Checks: read & write
- Metadata: read-only

Subscribe to these webhook events:

- `pull_request`
- `issue_comment`
- `pull_request_review_comment`

Important notes:

- `pull_request_review_comment` is required for replies on inline review threads.
- GitHub's current GitHub App permissions and events UI for this app does not expose a separate `Reactions` permission or `reaction` webhook subscription.
- After changing webhook subscriptions or permissions, re-install or update the GitHub App on the target repo or org.

### 2) Configure the environment

Copy `.env.example` to `.env` and set values.

`PROJECT_ROOT` must be an absolute path to this repo.

Additional variables:

- `INTERNAL_API_KEY` is required for internal APIs and retrieval tool access
- `CODEX_EXEC_PATH` points to `codex-exec` locally
- Docker worker uses `/usr/local/bin/codex-exec`
- `INTERNAL_API_KEY` also protects dashboard access through Basic or Bearer auth

### 3) Start services

```bash
docker compose up -d postgres redis
npm install
npm run prisma:generate
npm run prisma:migrate
docker compose up -d --build web worker
```

## Repo configuration

Preferred config file: `grepiku.json` in the repo root.

Legacy `greptile.json` and `.prreviewer.yml` are still supported.

```json
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

Notes:

- `graph.exclude_dirs` excludes repo-relative directory prefixes from graph generation and traversal seeding.
- `graph.traversal` controls how aggressively Grepiku expands review context.
- `retrieval` uses a vectorless PageIndex tree search over file, symbol, and chunk nodes.
- `output.syncSummaryWithStatus` keeps the PR body summary synchronized with review status runs.
- `output.allowIncrementalPrBodyUpdates` enables PR body summary updates on incremental runs.
- Scoped per-path overrides are supported via `.grepiku/config.json` for `strictness`, `commentTypes`, `ignore`, `limits`, and `rules`.
- If config is missing, defaults are used and tools are marked as skipped.

## Runtime notes

- Each run writes artifacts under `var/runs/<runId>`.
- Worker executes `codex-exec` directly and injects MCP roots for repo, bundle, and output paths.
- Review and mention pipelines are local-first by default, with GitHub API fallback.
- Review and mention-reply workloads run on separate BullMQ queues, so long reviews do not block `@grepiku` replies.
- On low changed-file coverage, Grepiku runs a supplemental coverage pass focused on uncovered files.
- On PR close, queued review jobs are cancelled and outcome signals are applied to finding weights.
- Bot-authored or suggestion-only push scenarios are filtered to avoid noisy self-reviews.
- Worker concurrency is tunable:
  - `REVIEW_WORKER_CONCURRENCY` (default `3`)
  - `MENTION_WORKER_CONCURRENCY` (default `3`)
- Tool runs are cached in Postgres per review run and tool.

## Endpoints

### Public

- `POST /webhooks` GitHub App webhook receiver
- `GET /healthz` health check

### Dashboard (`INTERNAL_API_KEY` auth)

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

### Internal API (`INTERNAL_API_KEY` auth)

- `POST /internal/review/enqueue`
- `POST /internal/index/enqueue`
- `POST /internal/rules/resolve`
- `POST /internal/retrieval`
- `POST /internal/triggers/update`

## Development

Run the main server and worker locally:

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

## PageIndex migration

To migrate existing indexed repos to the PageIndex retrieval model:

```bash
npm run migrate:pageindex
```

Preview the impact first:

```bash
npm run migrate:pageindex -- --dry-run
```

## Overnight loop

Run repeated manual review cycles with automatic retrieval tuning:

```bash
REVIEW_LOOP_REPO_FULL_NAME=owner/repo \
REVIEW_LOOP_PR_NUMBER=123 \
REVIEW_LOOP_MAX_CYCLES=40 \
npm run start:review-loop
```

Cycle logs are written to `var/loop/*.jsonl`.

## Traversal quality loop

Replay the evaluator over historical completed runs:

```bash
npm run check:traversal-quality
```

Optional filters and thresholds:

```bash
tsx src/tools/traversalQuality.ts --ci --replay --repo-id=2 --since-days=14 --limit=500 --concurrency=4
```

The command exits non-zero in `--ci` mode when recall, precision, or p95 SLO thresholds are violated.

## Optional tools

### MCP IDE server

```bash
npm run start:mcp-ide
```

### Local demo review runner

```bash
npm run start:demo -- --repo-path /absolute/path/to/repo
```
