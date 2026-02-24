FROM node:20-bookworm
ARG CODEX_VERSION=latest
RUN apt-get update \
  && apt-get install -y ripgrep git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@${CODEX_VERSION}

WORKDIR /opt/grepiku-tools
COPY docker/codex-runner/package.json ./
RUN npm install
COPY docker/codex-runner/tools ./tools

WORKDIR /work
