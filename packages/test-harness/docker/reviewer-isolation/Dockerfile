FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS audit-build
WORKDIR /build
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/package.json
RUN --network=none bun install --filter @factory/reviewer --production --ignore-scripts --frozen-lockfile \
  && bun build packages/reviewer/docker/submission-server.ts --target=bun --outfile=/audit-server.js

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

COPY packages/reviewer/docker/entrypoint.ts /probe.ts
COPY --from=audit-build /audit-server.js /opt/factory/audit-server.js
COPY --chmod=0555 packages/test-harness/docker/reviewer-isolation/fake-provider.ts /usr/local/bin/codex
COPY --chmod=0555 packages/test-harness/docker/reviewer-isolation/fake-provider.ts /usr/local/bin/claude

ENTRYPOINT ["bun", "run", "/probe.ts"]
