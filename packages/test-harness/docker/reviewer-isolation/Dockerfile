FROM oven/bun:1.3.11

COPY probe.ts /probe.ts
COPY --chmod=0555 fake-provider.ts /usr/local/bin/codex
COPY --chmod=0555 fake-provider.ts /usr/local/bin/claude

ENTRYPOINT ["bun", "run", "/probe.ts"]
