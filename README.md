# Grepiku

Internal GitHub App PR review bot powered by Codex.

## What It Does

- Inline review comments on PR diffs plus a summary
- Tracks findings across pushes and marks them as new, still open, or fixed
- Re-runs on new commits and on `/ai-review` comments
- 3-stage pipeline: reviewer, editor, execution verifier

## Architecture

- Fastify webhook server
- BullMQ worker
- Postgres for state
- Redis for queue
- Codex runner in Docker

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
  - `pull_request`
  - `issue_comment`

2) Configure environment

Copy `.env.example` to `.env` and set values. `PROJECT_ROOT` must be an absolute path to this repo.

3) Build Codex runner image

```bash
docker compose build codex-runner
```

4) Start services

```bash
docker compose up -d postgres redis
npm install
npm run prisma:generate
npm run prisma:migrate
docker compose up -d web worker
```

## Repo Configuration

Optional `.prreviewer.yml` in repo root:

```yaml
ignore:
  - "node_modules/**"
  - "dist/**"

tools:
  lint: { cmd: "pnpm lint", timeout_sec: 900 }
  build: { cmd: "pnpm build", timeout_sec: 1200 }
  test: { cmd: "pnpm test -- --ci", timeout_sec: 1800 }

limits:
  max_inline_comments: 20
  max_key_concerns: 5
```

If missing, the reviewer/editor still run and tools are marked as skipped.

## Runtime Notes

- Each run writes artifacts under `var/runs/<runId>`.
- The Codex runner mounts `/work/repo` as read-only and writes outputs to `/work/out`.
- Tool runs are cached in Postgres per (repo, PR, head SHA, tool).

## Endpoints

- `POST /webhooks` GitHub App webhook receiver
- `GET /healthz` health check

## Development

Run the server and worker locally:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev:server
npm run dev:worker
```
