#!/bin/sh
# Resolve compiler sources for the image indexer stage.
# - Local checkout with compiler/ in build context
# - Standalone repo: FETCH_COMPILER=1 clones beskid_compiler
set -eu

BUILDCTX="${1:?build context dir}"
DESTDIR="${2:?destination dir}"
FETCH_COMPILER="${FETCH_COMPILER:-0}"
COMPILER_GIT_URL="${COMPILER_GIT_URL:-https://github.com/Cyber-Nomad-Collective/beskid_compiler.git}"
COMPILER_GIT_REF="${COMPILER_GIT_REF:-main}"

mkdir -p "$(dirname "${DESTDIR}")"

if [ -f "${BUILDCTX}/compiler/Cargo.toml" ]; then
	cp -a "${BUILDCTX}/compiler" "${DESTDIR}"
	exit 0
fi

if [ "${FETCH_COMPILER}" = "1" ]; then
	rm -rf "${DESTDIR}"
	git clone --depth 1 --branch "${COMPILER_GIT_REF}" "${COMPILER_GIT_URL}" "${DESTDIR}"
	exit 0
fi

echo "compiler/ not found in build context and FETCH_COMPILER is not 1." >&2
echo "  docker compose build --build-arg FETCH_COMPILER=1" >&2
exit 1
