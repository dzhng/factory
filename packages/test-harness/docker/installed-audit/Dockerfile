FROM docker:29.8.0-cli@sha256:eccaacfeed644c7de222ff047483568cb988dde95476fbaaf10ea2d04921bb66 AS docker
FROM oven/bun:1.3.14 AS bun
FROM mcr.microsoft.com/playwright:v1.61.0-jammy
COPY --from=docker /usr/local/bin/docker /usr/bin/docker
COPY --from=bun /usr/local/bin/bun /opt/harness/bun
