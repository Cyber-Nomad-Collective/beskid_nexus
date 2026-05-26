#!/usr/bin/env bash
# Build the Beskid Nexus image with Podman (preferred) or Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-beskid-nexus:local}"

if command -v podman >/dev/null 2>&1; then
  BUILDER=podman
elif command -v docker >/dev/null 2>&1; then
  BUILDER=docker
else
  echo "Install Podman or Docker to build the Nexus image." >&2
  exit 1
fi

cd "${ROOT}"
git submodule update --init compiler
echo "Building ${IMAGE_TAG} with ${BUILDER} …"
"${BUILDER}" build -t "${IMAGE_TAG}" .
