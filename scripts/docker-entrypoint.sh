#!/bin/sh
set -eu

export GITNEXUS_HOME="${GITNEXUS_HOME:-/data/gitnexus}"
SERVE_PORT="${GITNEXUS_SERVE_PORT:-4747}"

if [ -n "${NEXUS_MCP_AUTH_TOKEN:-}" ]; then
	envsubst '${NEXUS_MCP_AUTH_TOKEN}' \
		< /etc/nginx/templates/default.conf.template \
		> /etc/nginx/conf.d/default.conf
else
	cat >/etc/nginx/conf.d/default.conf <<'EOF'
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    location = /api/health {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_pass http://127.0.0.1:4747;
    }

    location /api/ {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://127.0.0.1:4747;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF
fi

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
