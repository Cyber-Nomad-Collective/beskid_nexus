# Beskid Nexus — gitnexus serve (REST API, MCP, static web UI; runtime indexing)
#
# CI / GHCR (platform-delivery): context = beskid_nexus/, plus named BuildKit
# contexts:
#   web_common -> ./beskid_web_common  (file:../../beskid_web_common from gitnexus-web)
#   openspec   -> ./openspec
# Local:
#   docker build -f Dockerfile \
#     --build-context web_common=../beskid_web_common \
#     --build-context openspec=../openspec .

FROM oven/bun:latest AS builder

# Layout mirrors the superrepo so gitnexus-web file:../../beskid_web_common resolves.
WORKDIR /src/beskid_nexus

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates wget nodejs npm libgomp1 libatomic1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=web_common package.json bun.lock tsconfig.base.json /src/beskid_web_common/
COPY --from=web_common packages /src/beskid_web_common/packages
ARG NODE_AUTH_TOKEN
ENV NODE_AUTH_TOKEN=${NODE_AUTH_TOKEN}
ENV BUN_INSTALL_CACHE_DIR=/bun-cache
RUN --mount=type=cache,target=/bun-cache bun install --cwd=/src/beskid_web_common --frozen-lockfile

COPY .npmrc ./
COPY gitnexus-shared/package.json gitnexus-shared/bun.lock ./gitnexus-shared/
COPY gitnexus-shared ./gitnexus-shared
RUN --mount=type=cache,target=/bun-cache cd gitnexus-shared && bun install --frozen-lockfile && bun run build

COPY gitnexus/package.json gitnexus/bun.lock ./gitnexus/
COPY gitnexus ./gitnexus
COPY .npmrc ./gitnexus/.npmrc
COPY gitnexus-web/package.json gitnexus-web/bun.lock ./gitnexus-web/
COPY gitnexus-web ./gitnexus-web
COPY .npmrc ./gitnexus-web/.npmrc

ENV VITE_NEXUS_DEFAULT_REPO= \
    VITE_NEXUS_HOSTED=1
RUN --mount=type=cache,target=/bun-cache cd gitnexus && bun install --frozen-lockfile \
  && bun add --optional @ladybugdb/core-linux-x64@0.16.1 \
  && ln -sf ../core-linux-x64/lbugjs.node node_modules/@ladybugdb/core/lbugjs.node \
  && bun run build

# ── Runtime: gitnexus serve on PORT (API + web/) ───────────────────────────
FROM node:22-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /src/beskid_nexus/gitnexus/dist ./gitnexus/dist
COPY --from=builder /src/beskid_nexus/gitnexus/node_modules ./gitnexus/node_modules
COPY --from=builder /src/beskid_nexus/gitnexus/package.json ./gitnexus/package.json
COPY --from=builder /src/beskid_nexus/gitnexus/scripts/install-duckdb-extension.mjs ./gitnexus/scripts/install-duckdb-extension.mjs
COPY --from=builder /src/beskid_nexus/gitnexus/vendor ./gitnexus/vendor
COPY --from=builder /src/beskid_nexus/gitnexus/web ./gitnexus/web

# The root delivery workflow supplies this read-only named BuildKit context.
# Keeping it separate preserves the service-local primary build context while
# making the exact canonical standard catalog part of the immutable image.
COPY --from=openspec catalog.json /app/openspec/catalog.json

COPY scripts/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV GITNEXUS_HOME=/data/gitnexus \
    NEXUS_OPEN_SPEC_CATALOG=/app/openspec/catalog.json \
    NODE_ENV=production \
    GITNEXUS_SERVE_HOST=0.0.0.0 \
    PORT=8452

VOLUME /data/gitnexus

EXPOSE 8452

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8452/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
