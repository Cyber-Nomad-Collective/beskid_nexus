# Beskid Nexus — gitnexus serve (REST API, MCP, and static web UI)

FROM oven/bun:1.3.14 AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates wget nodejs npm libgomp1 libatomic1 \
  && rm -rf /var/lib/apt/lists/*

COPY gitnexus-shared/package.json gitnexus-shared/bun.lock ./gitnexus-shared/
COPY gitnexus-shared ./gitnexus-shared
RUN cd gitnexus-shared && bun install --frozen-lockfile && bun run build

COPY gitnexus/package.json gitnexus/bun.lock ./gitnexus/
COPY gitnexus ./gitnexus
COPY gitnexus-web/package.json gitnexus-web/bun.lock ./gitnexus-web/
COPY gitnexus-web ./gitnexus-web

ENV VITE_NEXUS_DEFAULT_REPO=compiler
RUN cd gitnexus && bun install --frozen-lockfile \
  && bun add --optional @ladybugdb/core-linux-x64@0.16.1 \
  && ln -sf ../core-linux-x64/lbugjs.node node_modules/@ladybugdb/core/lbugjs.node \
  && bun run build

RUN ln -sf /app/gitnexus/dist/cli/index.js /usr/local/bin/gitnexus

# ── Pre-index compiler at build time ───────────────────────────────────────
FROM builder AS indexer

ARG FETCH_COMPILER=0
ARG COMPILER_GIT_URL=https://github.com/Cyber-Nomad-Collective/beskid_compiler.git
ARG COMPILER_GIT_REF=main

ENV GITNEXUS_HOME=/data/gitnexus
RUN mkdir -p /data/gitnexus

COPY scripts/docker-prepare-compiler.sh /tmp/docker-prepare-compiler.sh
COPY . /buildctx/
RUN chmod +x /tmp/docker-prepare-compiler.sh \
  && FETCH_COMPILER="${FETCH_COMPILER}" \
     COMPILER_GIT_URL="${COMPILER_GIT_URL}" \
     COMPILER_GIT_REF="${COMPILER_GIT_REF}" \
     /tmp/docker-prepare-compiler.sh /buildctx /workspace/compiler

RUN test -f /workspace/compiler/Cargo.toml

RUN gitnexus analyze /workspace/compiler \
  --skip-agents-md \
  --skip-git \
  --skip-skills

# ── Runtime: gitnexus serve on PORT (API + web/) ───────────────────────────
FROM node:22-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=indexer /data/gitnexus /data/gitnexus
COPY --from=builder /app/gitnexus/dist ./gitnexus/dist
COPY --from=builder /app/gitnexus/node_modules ./gitnexus/node_modules
COPY --from=builder /app/gitnexus/package.json ./gitnexus/package.json
COPY --from=builder /app/gitnexus/scripts/install-duckdb-extension.mjs ./gitnexus/scripts/install-duckdb-extension.mjs
COPY --from=builder /app/gitnexus/vendor ./gitnexus/vendor
COPY --from=builder /app/gitnexus/web ./gitnexus/web

COPY scripts/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV GITNEXUS_HOME=/data/gitnexus \
    NODE_ENV=production \
    GITNEXUS_SERVE_HOST=0.0.0.0 \
    PORT=80

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
