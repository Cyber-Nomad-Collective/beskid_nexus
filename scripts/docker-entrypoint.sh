#!/bin/sh
set -eu

export GITNEXUS_HOME="${GITNEXUS_HOME:-/data/gitnexus}"
HOST="${GITNEXUS_SERVE_HOST:-0.0.0.0}"
PORT="${PORT:-80}"

exec node /app/gitnexus/dist/cli/index.js serve --host "${HOST}" --port "${PORT}"
