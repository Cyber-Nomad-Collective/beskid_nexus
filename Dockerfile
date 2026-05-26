# Beskid Nexus — superrepo build (context = repo root, file = beskid_nexus/Dockerfile)
ARG NPM_VERSION=11.14.1

# ── gitnexus CLI (native deps) ─────────────────────────────────────────────
FROM node:22-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS cli-builder
ARG NPM_VERSION
WORKDIR /app
RUN npx --yes npm@${NPM_VERSION} install -g npm@${NPM_VERSION}
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

COPY beskid_nexus/gitnexus-shared/package.json beskid_nexus/gitnexus-shared/package-lock.json ./gitnexus-shared/
RUN npm ci --prefix gitnexus-shared
COPY beskid_nexus/gitnexus-shared ./gitnexus-shared
RUN rm -f gitnexus-shared/tsconfig.tsbuildinfo && npm run build --prefix gitnexus-shared

COPY beskid_nexus/gitnexus ./gitnexus
RUN npm ci --prefix gitnexus && npm prune --omit=dev --prefix gitnexus
RUN ln -sf /app/gitnexus/dist/cli/index.js /usr/local/bin/gitnexus

# ── Pre-index compiler at build time ───────────────────────────────────────
FROM cli-builder AS indexer
ENV GITNEXUS_HOME=/data/gitnexus
RUN mkdir -p /data/gitnexus && chown -R node:node /data
COPY compiler /workspace/compiler
RUN test -f /workspace/compiler/Cargo.toml || (echo "compiler/ submodule missing — init before build" && exit 1)
RUN gitnexus analyze /workspace/compiler \
  --skip-embeddings \
  --skip-agents-md \
  --skip-git \
  --skip-skills

# ── Web UI ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS web-builder
ARG NPM_VERSION
WORKDIR /app
RUN npx --yes npm@${NPM_VERSION} install -g npm@${NPM_VERSION}

COPY beskid_nexus/gitnexus-shared/package.json beskid_nexus/gitnexus-shared/package-lock.json ./gitnexus-shared/
RUN npm ci --prefix gitnexus-shared
COPY beskid_nexus/gitnexus-shared ./gitnexus-shared
RUN npm run build --prefix gitnexus-shared

COPY packages/beskid-docs-ui/package.json /app/packages/beskid-docs-ui/package.json
COPY beskid_nexus/gitnexus-web/package.json beskid_nexus/gitnexus-web/package-lock.json ./gitnexus-web/
RUN npm ci --prefix gitnexus-web

COPY packages/beskid-docs-ui /app/packages/beskid-docs-ui
COPY beskid_nexus/gitnexus-web ./gitnexus-web
ENV VITE_NEXUS_SINGLE_REPO=1 \
    VITE_NEXUS_DEFAULT_REPO=compiler
RUN npm run build --prefix gitnexus-web

# ── Runtime: nginx + gitnexus serve ────────────────────────────────────────
FROM node:22-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx wget ca-certificates gettext-base \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app

COPY --from=indexer --chown=node:node /data/gitnexus /data/gitnexus
COPY --from=cli-builder --chown=node:node /app/gitnexus/dist ./gitnexus/dist
COPY --from=cli-builder --chown=node:node /app/gitnexus/node_modules ./gitnexus/node_modules
COPY --from=cli-builder --chown=node:node /app/gitnexus/package.json ./gitnexus/package.json
COPY --from=cli-builder --chown=node:node /app/gitnexus/scripts/install-duckdb-extension.mjs ./gitnexus/scripts/install-duckdb-extension.mjs
COPY --from=cli-builder --chown=node:node /app/gitnexus/vendor ./gitnexus/vendor
RUN ln -sf /app/gitnexus/dist/cli/index.js /usr/local/bin/gitnexus

COPY --from=web-builder /app/gitnexus-web/dist /usr/share/nginx/html
COPY beskid_nexus/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY beskid_nexus/scripts/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && chown -R node:node /data/gitnexus

ENV GITNEXUS_HOME=/data/gitnexus \
    NODE_ENV=production \
    GITNEXUS_SERVE_PORT=4747 \
    PORT=80

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
