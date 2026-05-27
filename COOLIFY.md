# Coolify: Beskid Nexus

Application: **beskid nexus** (`Cyber-Nomad-Collective/beskid_nexus`, branch `main`, repository root).

## Compose entry

**Coolify (GHCR):** [`docker-compose.coolify.yml`](docker-compose.coolify.yml)

**Local build:** [`docker-compose.yml`](docker-compose.yml) or [`infra/docker-compose.yml`](infra/docker-compose.yml)

## Build

- **Drone CI** pushes `ghcr.io/cyber-nomad-collective/beskid-nexus:${IMAGE_TAG}` (`.drone.yml`).
- **`NODE_AUTH_TOKEN`** is a Drone build secret, not Coolify.
- Image runs **`gitnexus serve` on port 8452** (no build-time index; no nginx).
- Indexes are created at **runtime** when admins add catalog entries or GitHub push webhooks fire. Graph data persists in the **`nexus-data`** volume (`GITNEXUS_HOME=/data/gitnexus`).

## Runtime secrets

| Variable | Required | Notes |
|----------|----------|--------|
| `SESSION_SECRET` | yes | ≥32 chars; seals session cookies |
| `AUTH_HUB_PUBLIC_URL` | yes | Shared [auth hub](../site/auth/COOLIFY.md); GitHub OAuth lives on the hub only |
| `NEXUS_ADMIN_GITHUB_LOGINS` | recommended | Comma-separated GitHub logins allowed to manage the catalog (also set via first-run setup) |
| `NEXUS_SETUP_TOKEN` | recommended (production) | Protects `POST /api/admin/setup` before the hub is paired |
| `NEXUS_MCP_AUTH_TOKEN` | recommended (production) | Bearer token for MCP and protected `/api/*` routes |
| `GITHUB_WEBHOOK_SECRET` | optional | Verifies `POST /api/webhooks/github` push events for re-index |
| `GITNEXUS_HOME` | set in compose | `/data/gitnexus` (volume) |
| `PORT` | optional | Default **8452** |

Pairing stores `authHubServiceToken` in `nexus-config.json` under `GITNEXUS_HOME`. Do not set per-app `GITHUB_CLIENT_ID` on Nexus.

## First boot

1. Map public URL to container port **8452**.
2. Deploy and pair the [auth hub](../site/auth/COOLIFY.md) (GitHub OAuth app + hub admin).
3. Open Nexus → **Connect Beskid Auth** setup: auth hub URL, pairing code from hub **Admin → Pairing** (app `nexus`), this Nexus public URL, admin GitHub logins.
4. Sign in with GitHub (via hub) → **Manage catalog** → add repos.

## MCP over HTTP

`https://<nexus-host>:8452/api/mcp` with `Authorization: Bearer <NEXUS_MCP_AUTH_TOKEN>` when the token is set.

## Health

`wget -q --spider http://127.0.0.1:8452/api/health`

## Local smoke

```bash
docker compose up --build
```
