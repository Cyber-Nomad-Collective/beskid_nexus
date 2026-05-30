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
| `SESSION_SECRET` | yes | ≥32 chars; seals session cookies |
| `AUTH_HUB_PUBLIC_URL` | yes | Shared [auth hub](../site/auth/COOLIFY.md); GitHub OAuth lives on the hub only |
| `NEXUS_SETUP_TOKEN` | recommended (production) | Protects `POST /api/admin/setup` before the hub is paired |
| `NEXUS_MCP_AUTH_TOKEN` | recommended (production) | Bearer token for MCP and protected `/api/*` routes |
| `GITHUB_WEBHOOK_SECRET` | optional | Verifies `POST /api/webhooks/github` push events for re-index |
| `OPENROUTER_API_KEY` | optional | Enables server-side code-doc maintenance after analyze (no public UI) |
| `NEXUS_DOC_MODEL` | optional | OpenRouter model id (e.g. `openrouter/free`); default applied when key is set |
| `NEXUS_SPEC_ROOT` | optional | Path to `site/website/src/content/docs/platform-spec` for **spec link index** only (not copied into code docs) |
| `GITNEXUS_HOME` | set in compose | `/data/gitnexus` (volume) |
| `PORT` | optional | Default **8452** |

`NEXUS_ADMIN_GITHUB_LOGINS` remains supported for **instance setup** pairing only; per-repo catalog CRUD is gated by **GitHub repo ownership**, not a global admin roster.

Pairing stores `authHubServiceToken` in `nexus-config.json` under `GITNEXUS_HOME`. Do not set per-app `GITHUB_CLIENT_ID` on Nexus.

## First boot

1. Map public URL to container port **8452**.
2. Deploy and pair the [auth hub](../site/auth/COOLIFY.md) (GitHub OAuth app + hub admin).
3. Open Nexus → **Connect Beskid Auth** setup: auth hub URL, pairing code from hub **Admin → Pairing** (app `nexus`), this Nexus public URL.
4. Sign in with GitHub (via hub). **Repo owners** add their repositories under **Manage repo**; the landing page opens the first indexed graph.

## Code documentation (operator)

When `OPENROUTER_API_KEY` is set, analyze completion triggers a background job that writes `code-docs/{registryName}.json` under `GITNEXUS_HOME`. Public graph responses expose `properties.codeDoc` and `properties.specLinks` separately — no AI or OpenRouter details in API or UI copy. Mount platform-spec MDX at `NEXUS_SPEC_ROOT` (or bake into the image) so spec links resolve to canonical site URLs.

## MCP over HTTP

`https://<nexus-host>:8452/api/mcp` with `Authorization: Bearer <NEXUS_MCP_AUTH_TOKEN>` when the token is set. Signed-in repo owners can copy the URL from **Connect MCP** in the web UI.

## Health

`wget -q --spider http://127.0.0.1:8452/api/health`

## Local smoke

```bash
docker compose up --build
```

Then open the mapped port: graph-first landing, repo selector, and (when signed in as a GitHub repo owner) **Manage repo** and **Connect MCP**.
