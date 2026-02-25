FROM rust:1.93-bookworm AS codex-build
RUN apt-get update \
  && apt-get install -y pkg-config libssl-dev libcap-dev ca-certificates build-essential clang libclang-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/codex
COPY internal_harness/codex-slim/ ./
ENV CARGO_PROFILE_RELEASE_LTO=true \
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
  CARGO_PROFILE_RELEASE_STRIP=symbols \
  CODEX_BWRAP_SOURCE_DIR=/opt/codex/vendor/bubblewrap
RUN test -f /opt/codex/vendor/bubblewrap/bubblewrap.c \
  || (echo "Missing vendored bubblewrap at /opt/codex/vendor/bubblewrap" && ls -la /opt/codex/vendor && exit 1)
RUN cargo build -p codex-exec --release --locked

FROM node:20-bookworm AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM node:20-bookworm AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run prisma:generate
RUN npm run build

FROM node:20-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Runtime tools used by codex-exec and MCP helpers.
RUN apt-get update \
  && apt-get install -y ripgrep git ca-certificates libcap2 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=codex-build /opt/codex/target/release/codex-exec /usr/local/bin/codex-exec
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY docker/codex-runner/tools ./docker/codex-runner/tools
COPY package.json ./
CMD ["node", "dist/server.js"]
