# PersonXAI — self-hosted container.
#
# PersonXAI is a Cloudflare Worker (Durable Objects, Workers AI binding, cron
# triggers). Rather than reimplementing that runtime for Node, the image runs
# the SAME code on workerd via `wrangler dev` (Miniflare): Durable Objects,
# SQLite state, static assets and the fetch handler all behave as in
# production. Cron is replaced by a sidecar hitting POST /dispatch every
# minute (see docker-compose.yml); Workers AI is replaced by any external
# LLM preset (docs/DOCKER.md).
#
#   docker build -t personxai .
#   docker run --env-file .dev.vars -p 8787:8787 -v personxai-data:/data personxai

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    CI=true \
    WRANGLER_SEND_METRICS=false \
    PERSONXAI_PORT=8787 \
    PERSONXAI_WRANGLER_CONFIG=wrangler.docker.jsonc \
    PERSONXAI_DATA_DIR=/data

RUN apt-get update \b
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY wrangler.jsonc wrangler.docker.jsonc ./
COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/personxai-entrypoint
RUN chmod +x /usr/local/bin/personxai-entrypoint && chown -R node:node /app

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PERSONXAI_PORT}/health" || exit 1

ENTRYPOINT ["personxai-entrypoint"]
