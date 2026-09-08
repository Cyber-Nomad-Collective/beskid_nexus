# Coolify: Beskid Nexus

Application: **beskid nexus** (`Cyber-Nomad-Collective/beskid_nexus`, branch `main`, repository root).

## Compose entry

**Coolify (GHCR):** [`docker-compose.coolify.yml`](docker-compose.coolify.yml)

**Local build:** [`docker-compose.yml`](docker-compose.yml) or [`infra/docker-compose.yml`](infra/docker-compose.yml)

## Build

- **GitHub Actions** pushes `ghcr.io/cyber-nomad-collective/beskid-nexus:${IMAGE_TAG}` (`.github/workflows/container-images.yml`).
- **`NODE_AUTH_TOKEN`** is a GitHub Actions build secret, not Coolify.
- Image runs **`gitnexus serve` on port 8452** (no build-time index; no nginx).
- Indexes are created at **runtime** when repo owners add catalog entries or GitHub push webhooks fire. Graph data persists in the **`nexus-data`** volume (`GITNEXUS_HOME=/data/gitnexus`).

## Runtime secrets

| Variable | Required | Notes |
|----------|----------|--------|
| `NEXUS_AUTHENTIK_ADMIN_GROUPS` | yes | Comma-separated Authentik groups allowed to administer the catalog; default `nexus-admin` |
| `NEXUS_AUTHENTIK_ADMIN_USERS` | optional | Comma-separated Authentik usernames allowed to administer the catalog |
| `NEXUS_MCP_AUTH_TOKEN` | recommended (production) | Bearer token for MCP and protected `/api/*` routes |
| `GITHUB_WEBHOOK_SECRET` | optional | Verifies `POST /api/webhooks/github` push events for re-index |
| `OPENROUTER_API_KEY` | optional | Enables server-side code-doc maintenance after analyze (no public UI) |
| `NEXUS_DOC_MODEL` | optional | OpenRouter model id (e.g. `openrouter/free`); default applied when key is set |
| `NEXUS_OPEN_SPEC_CATALOG` | optional | Path to the mounted `openspec/catalog.json` used for typed standard links (not copied into code docs) |
| `GITNEXUS_HOME` | set in compose | `/data/gitnexus` (volume) |
| `PORT` | optional | Default **8452**; bind the host port to loopback only |

Nexus has no local login, OAuth client, session secret, or pairing token. Caddy is
the only public entry point. Its Authentik `forward_auth` configuration must copy
`X-Authentik-Username`, `X-Authentik-Name`, `X-Authentik-Email`, and
`X-Authentik-Groups` to Nexus; the server uses those headers solely for the
already Caddy-protected request.

Do not publish port 8452 directly. The supplied Compose files bind it to
`127.0.0.1:8452` so Caddy can be the external trust boundary.

## First boot

1. Configure Authentik and Caddy to protect the Nexus hostname, forwarding the
   four `X-Authentik-*` headers above.
2. Keep the Nexus container reachable only through the loopback mapping.
3. Set `NEXUS_AUTHENTIK_ADMIN_GROUPS` (or the explicit-user override) in
   Coolify, then deploy.
4. An Authentik administrator can add repositories under **Manage repo**; the
   landing page opens the first indexed graph.

## Code documentation (operator)

When `OPENROUTER_API_KEY` is set, analyze completion triggers a background job that writes `code-docs/{registryName}.json` under `GITNEXUS_HOME`. Public graph responses expose `properties.codeDoc` and typed `properties.specLinks` separately — no AI or OpenRouter details in API or UI copy. Mount the generated OpenSpec catalog and set `NEXUS_OPEN_SPEC_CATALOG`; its revision and content hash invalidate Nexus's persisted link index automatically.

## MCP over HTTP

`https://<nexus-host>/api/mcp` with `Authorization: Bearer <NEXUS_MCP_AUTH_TOKEN>`
when the token is set. Authentik administrators can copy the URL from **Connect
MCP** in the web UI.

## Health

`wget -q --spider http://127.0.0.1:8452/api/health`

## Local smoke

```bash
docker compose up --build
```

Then open the Caddy-protected hostname: graph-first landing, repo selector, and
(for an Authentik administrator) **Manage repo** and **Connect MCP**.

## Platform matrix

Cross-service URLs, OpenBao paths, and shared auth variables: [beskid_infra/docs/deploy-matrix.md](../beskid_infra/docs/deploy-matrix.md).
