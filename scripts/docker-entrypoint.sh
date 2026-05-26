#!/bin/sh
set -eu

export GITNEXUS_HOME="${GITNEXUS_HOME:-/data/gitnexus}"
SERVE_PORT="${GITNEXUS_SERVE_PORT:-4747}"

envsubst '${NEXUS_MCP_AUTH_TOKEN}' \
	< /etc/nginx/templates/default.conf.template \
	> /etc/nginx/conf.d/default.conf

node /app/gitnexus/dist/cli/index.js serve \
	--host 127.0.0.1 \
	--port "${SERVE_PORT}" &

SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 90); do
	if wget -q --spider "http://127.0.0.1:${SERVE_PORT}/api/health" 2>/dev/null; then
		exec nginx -g 'daemon off;'
	fi
	sleep 1
done

echo "gitnexus serve did not become healthy on port ${SERVE_PORT}" >&2
exit 1
