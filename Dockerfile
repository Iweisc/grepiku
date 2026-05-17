FROM node:20-trixie AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM rust:1.91-slim-bookworm AS codex-build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y build-essential pkg-config libcap-dev libssl-dev perl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY internal_harness/codex-slim ./internal_harness/codex-slim
RUN cd internal_harness/codex-slim && cargo build -p codex-exec --release --locked

FROM node:20-trixie AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run prisma:generate
RUN npm run build

FROM node:20-trixie AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV GRAPHIFY_PYTHON_BIN=/opt/graphify-venv/bin/python
RUN apt-get update \
  && apt-get install -y ripgrep git ca-certificates libcap2 python3 python3-pip python3-venv \
  && python3 -m venv /opt/graphify-venv \
  && /opt/graphify-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/graphify-venv/bin/pip install --no-cache-dir "git+https://github.com/Iweisc/graphify.git@grepiku-review-context#egg=graphifyy" \
  && rm -rf /var/lib/apt/lists/*
COPY --from=codex-build /app/internal_harness/codex-slim/target/release/codex-exec /usr/local/bin/codex-exec
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY docker/codex-runner/tools ./docker/codex-runner/tools
COPY package.json ./
CMD ["node", "dist/server.js"]

FROM runtime AS sandbox
CMD ["node", "dist/sandbox/entrypoint.js"]
