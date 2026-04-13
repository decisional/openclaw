#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

test -f .env || {
  echo ".env missing. Run ./bootstrap-docker-stack.sh first." >&2
  exit 1
}

COMPOSE_ARGS=(-f docker-compose.yml -f docker-compose.proxy.yml)

DOCKER_BUILDKIT=1 docker build -t openclaw:local -f Dockerfile .
docker compose "${COMPOSE_ARGS[@]}" up -d openclaw-gateway openclaw-proxy
docker compose "${COMPOSE_ARGS[@]}" ps
