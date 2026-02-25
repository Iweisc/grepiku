# Grepiku

GitHub PR review bot powered by Codex.

## What It Does

- Inline review comments on PR diffs plus a summary
- Tracks findings across pushes and marks them as new, still open, or fixed
- Re-runs on new commits and on `/review` comments
- 3-stage pipeline: reviewer, editor, execution verifier
- Hybrid context retrieval (embeddings + lexical + changed-path boosts) with graph-aware related files
- Deterministic quality gate to dedupe overlapping findings and prioritize high-signal comments

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
  - Pull requests: read
  - Issues: read & write
  - Reactions: write
  - Contents: read
  - Checks: read
- Subscribe to webhook events:
  - `pull_request`, `issue_comment`, `pull_request_review_comment`, `reaction`

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

If missing, defaults are used and tools are marked as skipped.

## Runtime Notes

- Each run writes artifacts under `var/runs/<runId>`.
- Worker executes `codex-exec` directly and injects MCP roots for repo/bundle/out paths.
- Tool runs are cached in Postgres per (review run, tool).

## Endpoints

- `POST /webhooks` GitHub App webhook receiver
- `GET /healthz` health check
- `GET /dashboard` analytics UI
- Internal API: `/internal/review/enqueue`, `/internal/index/enqueue`, `/internal/rules/resolve`, `/internal/retrieval`

## Development

Run the server and worker locally:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev:server
npm run dev:worker
```
