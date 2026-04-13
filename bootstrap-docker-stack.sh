#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

COMPOSE_ARGS=(-f docker-compose.yml -f docker-compose.proxy.yml)
DATA_ROOT="${OPENCLAW_DEPLOY_HOME:-$HOME/openclaw-docker}"

if [[ -f .env ]]; then
  set -a
  . ./.env
  set +a
fi

export OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$DATA_ROOT/config}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$DATA_ROOT/workspace}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
export OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
export OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-openclaw:local}"
export OPENCLAW_TZ="${OPENCLAW_TZ:-UTC}"
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(openssl rand -hex 32)}"

cat > .env <<ENVEOF
OPENCLAW_CONFIG_DIR=$OPENCLAW_CONFIG_DIR
OPENCLAW_WORKSPACE_DIR=$OPENCLAW_WORKSPACE_DIR
OPENCLAW_GATEWAY_PORT=$OPENCLAW_GATEWAY_PORT
OPENCLAW_BRIDGE_PORT=$OPENCLAW_BRIDGE_PORT
OPENCLAW_GATEWAY_BIND=$OPENCLAW_GATEWAY_BIND
OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN
OPENCLAW_IMAGE=$OPENCLAW_IMAGE
OPENCLAW_TZ=$OPENCLAW_TZ
ENVEOF
chmod 600 .env

mkdir -p "$DATA_ROOT" "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR"
chmod 700 "$DATA_ROOT" "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR"

if ! docker image inspect "$OPENCLAW_IMAGE" >/dev/null 2>&1; then
  DOCKER_BUILDKIT=1 docker build -t "$OPENCLAW_IMAGE" -f Dockerfile .
fi

# Make host-created bind mounts writable by the container's node user.
docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --user root --entrypoint sh openclaw-gateway -c \
  'find /home/node/.openclaw -xdev -exec chown node:node {} +; [ -d /home/node/.openclaw/workspace/.openclaw ] && chown -R node:node /home/node/.openclaw/workspace/.openclaw || true'

AUTH_PROFILES_PATH="$OPENCLAW_CONFIG_DIR/agents/main/agent/auth-profiles.json"
if [[ ! -f "$AUTH_PROFILES_PATH" ]]; then
  : "${OPENAI_API_KEY:?OPENAI_API_KEY must be set for first-time bootstrap when auth profiles are missing}"
  docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --entrypoint node openclaw-gateway \
    dist/index.js onboard \
    --non-interactive \
    --accept-risk \
    --flow quickstart \
    --mode local \
    --auth-choice openai-api-key \
    --openai-api-key "$OPENAI_API_KEY" \
    --gateway-auth token \
    --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
    --gateway-port "$OPENCLAW_GATEWAY_PORT" \
    --gateway-bind loopback \
    --workspace /home/node/.openclaw/workspace \
    --skip-channels \
    --skip-skills \
    --skip-search \
    --skip-daemon \
    --skip-ui \
    --skip-health
else
  echo "Existing auth profiles found; skipping onboarding."
fi

docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js config set --batch-json \
  '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"},{"path":"gateway.controlUi.allowedOrigins","value":["http://localhost:18789","http://127.0.0.1:18789","http://localhost:8080","http://127.0.0.1:8080"]}]'

docker compose "${COMPOSE_ARGS[@]}" up -d openclaw-gateway openclaw-proxy
