# Grepiku

GitHub PR review bot powered by Codex.

## What It Does

- Inline review comments on PR diffs plus a summary
- Tracks findings across pushes and marks them as new, still open, or fixed
- Re-runs on new commits and on `/review` comments
- Mention workflow: `@grepiku` answers questions, and `@grepiku do: ...` applies code changes and opens a follow-up PR
- 3-stage pipeline: reviewer, editor, execution verifier
- Hybrid context retrieval (semantic + lexical + RRF + changed-path boosts) with graph-aware related files
- Full-repo embeddings with file, symbol, and chunk vectors for deeper codebase context
- Deterministic quality gate to dedupe overlapping findings and prioritize high-signal comments
- First PR bootstrap: full-codebase indexing + graph build, then incremental refresh on subsequent changes

## Architecture

- Fastify webhook server
- BullMQ workers (review-orchestrator, indexer, graph-builder, analytics-ingest)
- Postgres for state
- Redis for queue
- Direct `codex-exec` integration from `internal_harness/codex-slim`

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
      "min_score": 0.09,
      "max_related_files": 18,
      "max_graph_links": 80,
      "hard_include_files": 5,
      "max_nodes_visited": 1800
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
  "output": { "summaryOnly": false, "destination": "comment" },
  "retrieval": {
    "topK": 18,
    "maxPerPath": 4,
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

If missing, defaults are used and tools are marked as skipped.

## Runtime Notes

- Each run writes artifacts under `var/runs/<runId>`.
- Worker executes `codex-exec` directly and injects MCP roots for repo/bundle/out paths.
- Review and mention pipelines are local-first: diff/changed-file context is computed from local git checkout by default, with GitHub API as fallback.
- Tool runs are cached in Postgres per (review run, tool).

## Endpoints

- `POST /webhooks` GitHub App webhook receiver
- `GET /healthz` health check
- `GET /dashboard` analytics UI
- Internal API: `/internal/review/enqueue`, `/internal/index/enqueue`, `/internal/rules/resolve`, `/internal/retrieval`
- Traversal metrics API: `/api/analytics/traversal`

## Development

Run the server and worker locally:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev:server
npm run dev:worker
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
