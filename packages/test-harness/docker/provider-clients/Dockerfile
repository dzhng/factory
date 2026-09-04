FROM node:22-bookworm-slim

ARG CODEX_VERSION
ARG CLAUDE_VERSION

RUN test -n "${CODEX_VERSION}" \
  && test -n "${CLAUDE_VERSION}" \
  && npm install --global "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
  && npm cache clean --force

COPY probe-client-help.mjs /opt/factory/probe-client-help.mjs

ENV HOME=/tmp/provider-home \
  CODEX_HOME=/tmp/provider-home/codex \
  CLAUDE_CONFIG_DIR=/tmp/provider-home/claude \
  DISABLE_AUTOUPDATER=1 \
  NO_COLOR=1

ENTRYPOINT ["node", "/opt/factory/probe-client-help.mjs"]
