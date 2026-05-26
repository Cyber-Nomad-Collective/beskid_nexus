#!/usr/bin/env bash
# Build the Beskid Nexus image with Podman (preferred) or Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-beskid-nexus:local}"
FETCH_COMPILER="${FETCH_COMPILER:-1}"

if command -v podman >/dev/null 2>&1; then
  BUILDER=podman
elif command -v docker >/dev/null 2>&1; then
  BUILDER=docker
else
  echo "Install Podman or Docker to build the Nexus image." >&2
  exit 1
fi

cd "${ROOT}"
echo "Building ${IMAGE_TAG} with ${BUILDER} (FETCH_COMPILER=${FETCH_COMPILER}) …"
"${BUILDER}" build -t "${IMAGE_TAG}" --build-arg "FETCH_COMPILER=${FETCH_COMPILER}" .
