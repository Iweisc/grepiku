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

FROM node:20-bookworm
RUN apt-get update \
  && apt-get install -y ripgrep git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=codex-build /opt/codex/target/release/codex-exec /usr/local/bin/codex-exec

WORKDIR /opt/grepiku-tools
COPY docker/codex-runner/package.json ./
RUN npm install
COPY docker/codex-runner/tools ./tools

WORKDIR /work
