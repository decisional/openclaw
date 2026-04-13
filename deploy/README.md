# Docker VM Deploy

This repo includes a small Docker VM deploy shape for Ubuntu-style hosts:

- `openclaw-gateway` runs from the repo's local Docker image
- `openclaw-proxy` is an nginx container that exposes `:8080` and proxies to the gateway on `:18789`
- runtime state stays outside the container under `~/openclaw-docker` by default

## Files

- `bootstrap-docker-stack.sh`
  - first-time setup for a host
  - builds the image if needed
  - creates `.env`
  - runs non-interactive onboarding only if auth profiles do not already exist
  - starts the gateway and proxy containers
- `redeploy-docker-stack.sh`
  - rebuilds the local image from the current checkout
  - recreates the gateway and proxy containers
- `docker-compose.proxy.yml`
  - adds the nginx proxy service
- `deploy/nginx/openclaw-proxy.conf`
  - nginx config for `:8080 -> openclaw-gateway:18789`

## First-time bootstrap

If the host does not already have OpenClaw auth profiles, export an API key for the bootstrap process:

```bash
export OPENAI_API_KEY=...
```

Then run:

```bash
cd ~/openclaw
./bootstrap-docker-stack.sh
```

If auth profiles already exist in `OPENCLAW_CONFIG_DIR`, bootstrap skips onboarding and reuses them.

## Redeploy after `git pull`

```bash
cd ~/openclaw
git pull
./redeploy-docker-stack.sh
```

## Defaults

The scripts write a repo-local `.env` with:

- `OPENCLAW_CONFIG_DIR=$HOME/openclaw-docker/config`
- `OPENCLAW_WORKSPACE_DIR=$HOME/openclaw-docker/workspace`
- `OPENCLAW_GATEWAY_PORT=18789`
- `OPENCLAW_BRIDGE_PORT=18790`
- `OPENCLAW_GATEWAY_BIND=lan`
- `OPENCLAW_IMAGE=openclaw:local`
- `OPENCLAW_TZ=UTC`
- `OPENCLAW_GATEWAY_TOKEN=<generated token>`

Override the data root if needed:

```bash
export OPENCLAW_DEPLOY_HOME=/srv/openclaw
```

## Health checks

Local:

```bash
curl http://127.0.0.1:18789/healthz
curl http://127.0.0.1:8080/healthz
```

Public via proxy:

```bash
curl http://<host>:8080/healthz
```

## Notes

- `.env` is ignored and should stay host-specific.
- `deploy-docker-test.sh` is a compatibility wrapper for the bootstrap script.
- This commit sets up the Dockerized VM deploy path and the public nginx proxy path. It does not change repo CI/CD or registry publishing.
