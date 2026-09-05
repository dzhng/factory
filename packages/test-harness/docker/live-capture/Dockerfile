FROM ghcr.io/dzhng/factory-reviewer@sha256:8b4d1bb63f727a791c5c20084a840cc75963becaa9225612acf6f42858eb561c

RUN apt-get update && apt-get install --yes --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
COPY packages/cli/dist/factory.js /opt/factory/factory.js
COPY packages/test-harness/docker/live-capture/provider.ts /opt/factory/docker/live-capture/provider.ts
COPY packages/test-harness/src/live-capture-contract.ts /opt/factory/src/live-capture-contract.ts
COPY packages/test-harness/docker/live-capture/prepare-bundle.ts /opt/factory/prepare-bundle.ts
COPY packages/test-harness/docker/live-capture/factory.ts /usr/local/bin/factory
RUN chmod 755 /usr/local/bin/factory \
  && chmod 755 /opt/factory/docker/live-capture/provider.ts \
  && rm /usr/local/bin/codex /usr/local/bin/claude \
  && ln -s /opt/factory/docker/live-capture/provider.ts /usr/local/bin/codex \
  && ln -s /opt/factory/docker/live-capture/provider.ts /usr/local/bin/claude
