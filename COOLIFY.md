# Coolify: Beskid Nexus

Application: **beskid nexus** (`Cyber-Nomad-Collective/beskid_nexus`, branch `main`, repository root).

## Compose entry

Use [`docker-compose.yml`](docker-compose.yml) or [`infra/docker-compose.yml`](infra/docker-compose.yml). **Build context is this repository root**.

Superrepo local builds: [`docker-compose.superrepo.yml`](docker-compose.superrepo.yml) (same image, shared volume layout).

## Build

- Image: [`Dockerfile`](Dockerfile) — `gitnexus` + web UI, **`gitnexus serve` on port 8452** (no build-time index; no nginx).
- Indexes are created at **runtime** when admins add catalog entries or GitHub push webhooks fire. Graph data persists in the **`nexus-data`** volume (`GITNEXUS_HOME=/data/gitnexus`).

## Runtime secrets

| Variable | Required | Notes |
|----------|----------|--------|
| `SESSION_SECRET` | yes (OAuth) | ≥32 chars; seals session cookies |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_OAUTH_CALLBACK_URL` | yes (or via first-run `/setup` UI → `nexus-config.json`) | GitHub OAuth app |
| `NEXUS_ADMIN_GITHUB_LOGINS` | recommended | Comma-separated GitHub logins allowed to manage the catalog |
| `NEXUS_SETUP_TOKEN` | recommended (production) | Protects `POST /api/admin/setup` when OAuth is not yet configured |
| `NEXUS_MCP_AUTH_TOKEN` | recommended (production) | Bearer token for MCP and protected `/api/*` routes |
| `GITHUB_WEBHOOK_SECRET` | optional | Verifies `POST /api/webhooks/github` push events for re-index |
| `GITNEXUS_HOME` | set in compose | `/data/gitnexus` (volume) |
| `PORT` | optional | Default **8452** |

## First boot

1. Map public URL to container port **8452**.
2. Open the site → complete **GitHub OAuth setup** (or pre-set env vars).
3. Sign in with GitHub as an admin → **Manage catalog** → add repos (display name, description, URL).
4. Server clones and indexes each repo; graphs appear on the catalog home when ready.

## MCP over HTTP

`https://<nexus-host>:8452/api/mcp` with `Authorization: Bearer <NEXUS_MCP_AUTH_TOKEN>` when the token is set.

## Health

`wget -q --spider http://127.0.0.1:8452/api/health`

## Local smoke

```bash
podman compose up --build
```

Open `http://localhost:8452/`.

## Related

- [Docs site](../site/COOLIFY.md)
- [Tracker](../beskid_tracker/COOLIFY.md)
