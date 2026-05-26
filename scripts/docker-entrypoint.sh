#!/bin/sh
set -eu

export GITNEXUS_HOME="${GITNEXUS_HOME:-/data/gitnexus}"
SERVE_PORT="${GITNEXUS_SERVE_PORT:-4747}"

export NEXUS_MCP_AUTH_TOKEN="${NEXUS_MCP_AUTH_TOKEN:-}"
envsubst '${NEXUS_MCP_AUTH_TOKEN}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

node /app/gitnexus/dist/cli/index.js serve \
  --host 127.0.0.1 \
  --port "${SERVE_PORT}" &

SERVE_PID=$!

cleanup() {
  kill "${SERVE_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for backend health before nginx accepts traffic
for i in $(seq 1 60); do
  if wget -q --spider "http://127.0.0.1:${SERVE_PORT}/api/health" 2>/dev/null; then
    break
  fi
  sleep 1
done

exec nginx -g 'daemon off;'
