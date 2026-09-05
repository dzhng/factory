FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ARG CODEX_VERSION=0.144.4
ARG CLAUDE_VERSION=2.1.261

RUN test -n "${CODEX_VERSION}" \
  && test -n "${CLAUDE_VERSION}" \
  && npm install --global "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
  && npm cache clean --force

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY packages/reviewer/docker/entrypoint.ts /opt/factory/reviewer-entrypoint.ts

ENV DISABLE_AUTOUPDATER=1 \
  NO_COLOR=1

LABEL org.opencontainers.image.source="https://github.com/dzhng/factory" \
  org.opencontainers.image.description="Ephemeral Codex and Claude reviewer for Factory"

ENTRYPOINT ["bun", "run", "/opt/factory/reviewer-entrypoint.ts"]
