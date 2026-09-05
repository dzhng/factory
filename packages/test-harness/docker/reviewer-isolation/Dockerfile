FROM oven/bun:1.3.14

COPY packages/reviewer/docker/entrypoint.ts /probe.ts
COPY --chmod=0555 packages/test-harness/docker/reviewer-isolation/fake-provider.ts /usr/local/bin/codex
COPY --chmod=0555 packages/test-harness/docker/reviewer-isolation/fake-provider.ts /usr/local/bin/claude

ENTRYPOINT ["bun", "run", "/probe.ts"]
