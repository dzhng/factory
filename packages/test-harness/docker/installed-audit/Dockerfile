FROM docker:29.8.0-cli@sha256:eccaacfeed644c7de222ff047483568cb988dde95476fbaaf10ea2d04921bb66 AS docker
FROM oven/bun:1.3.14
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists \
  && mkdir -p /opt/harness && mv /usr/local/bin/bun /opt/harness/bun
COPY --from=docker /usr/local/bin/docker /usr/bin/docker
CMD ["/bin/sh"]
