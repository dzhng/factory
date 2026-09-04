FROM oven/bun:1.3.11 AS bun
FROM mcr.microsoft.com/playwright:v1.61.0-jammy
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
