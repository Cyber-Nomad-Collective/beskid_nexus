# Beskid Nexus — standalone repo build (context = repository root)

# ── gitnexus CLI (native deps) ─────────────────────────────────────────────
FROM oven/bun:1.3.14 AS cli-builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates wget nodejs npm libgomp1 libatomic1 \
  && rm -rf /var/lib/apt/lists/*

COPY gitnexus-shared/package.json ./gitnexus-shared/package.json
COPY gitnexus-shared/bun.lock ./gitnexus-shared/bun.lock
COPY gitnexus-shared ./gitnexus-shared
RUN cd gitnexus-shared && bun install --frozen-lockfile && bun run build

COPY gitnexus/package.json ./gitnexus/package.json
COPY gitnexus/bun.lock ./gitnexus/bun.lock
COPY gitnexus ./gitnexus
RUN cd gitnexus && bun install --frozen-lockfile \
  && bun add --optional @ladybugdb/core-linux-x64@0.16.1 \
  && ln -sf ../core-linux-x64/lbugjs.node node_modules/@ladybugdb/core/lbugjs.node \
  && bun run build

RUN ln -sf /app/gitnexus/dist/cli/index.js /usr/local/bin/gitnexus

# ── Pre-index compiler at build time ───────────────────────────────────────
FROM cli-builder AS indexer
ENV GITNEXUS_HOME=/data/gitnexus
RUN mkdir -p /data/gitnexus

COPY compiler /workspace/compiler
RUN test -f /workspace/compiler/Cargo.toml \
  || (echo "compiler/ missing — run: git submodule update --init compiler" && exit 1)

RUN gitnexus analyze /workspace/compiler \
  --skip-agents-md \
  --skip-git \
  --skip-skills

# ── Web UI ─────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14 AS web-builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates wget nodejs npm libgomp1 libatomic1 \
  && rm -rf /var/lib/apt/lists/*

COPY gitnexus-shared/package.json ./gitnexus-shared/package.json
COPY gitnexus-shared/bun.lock ./gitnexus-shared/bun.lock
COPY gitnexus-shared ./gitnexus-shared
RUN cd gitnexus-shared && bun install --frozen-lockfile && bun run build

COPY gitnexus/package.json ./gitnexus/package.json
COPY gitnexus-web/package.json ./gitnexus-web/package.json
COPY gitnexus-web/bun.lock ./gitnexus-web/bun.lock
COPY gitnexus-web ./gitnexus-web

RUN cd gitnexus-web && bun install --frozen-lockfile
ENV VITE_NEXUS_DEFAULT_REPO=compiler
RUN cd gitnexus-web && bun run build

# ── Runtime: nginx + gitnexus serve ────────────────────────────────────────
FROM node:22-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx wget ca-certificates gettext-base \
  && rm -f /etc/nginx/sites-enabled/default \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=indexer /data/gitnexus /data/gitnexus
COPY --from=cli-builder /app/gitnexus/dist ./gitnexus/dist
COPY --from=cli-builder /app/gitnexus/node_modules ./gitnexus/node_modules
COPY --from=cli-builder /app/gitnexus/package.json ./gitnexus/package.json
COPY --from=cli-builder /app/gitnexus/scripts/install-duckdb-extension.mjs ./gitnexus/scripts/install-duckdb-extension.mjs
COPY --from=cli-builder /app/gitnexus/vendor ./gitnexus/vendor
RUN ln -sf /app/gitnexus/dist/cli/index.js /usr/local/bin/gitnexus

COPY --from=web-builder /app/gitnexus-web/dist /usr/share/nginx/html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY scripts/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV GITNEXUS_HOME=/data/gitnexus \
    NODE_ENV=production \
    GITNEXUS_SERVE_PORT=4747 \
    PORT=80

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
