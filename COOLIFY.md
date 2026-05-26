# Coolify: Beskid Nexus

Application: **beskid nexus** (`Cyber-Nomad-Collective/beskid_nexus`, branch `main`, repository root).

## Compose entry

Use [`docker-compose.yml`](docker-compose.yml) or [`infra/docker-compose.yml`](infra/docker-compose.yml). **Build context is this repository root** (`context: .`, `dockerfile: Dockerfile`).

For the Beskid superrepo checkout, use [`docker-compose.superrepo.yml`](docker-compose.superrepo.yml) instead (`context: ..`, `dockerfile: beskid_nexus/Dockerfile.superrepo`).

## Compiler submodule (required)

The Nexus image **indexes `compiler/` at build time**. This repo vendors the compiler as a **`compiler` git submodule** (`beskid_compiler`).

1. Enable **recursive submodule init** on clone in Coolify (or run `git submodule update --init --recursive` before build).
2. Prefer a **non-shallow** submodule fetch if the pinned SHA fails on shallow clones.
3. Build fails fast if `compiler/Cargo.toml` is missing.

## Build

- Image: [`Dockerfile`](Dockerfile) — multi-stage: `gitnexus analyze` on `compiler/`, static web UI, `gitnexus serve` behind nginx on port **80**.
- Graph data is **baked into the image**; redeploy after bumping the `compiler` submodule pointer to refresh.

## Runtime secrets

| Variable | Required | Notes |
|----------|----------|--------|
| `NEXUS_MCP_AUTH_TOKEN` | recommended (production) | Bearer token for `/api/*` (including MCP). Leave empty for local smoke only. |
| `GITNEXUS_HOME` | optional | Default `/data/gitnexus` (pre-populated in image) |
| `PORT` | optional | nginx listen; default `80` |

## MCP over HTTP

GitNexus `serve` exposes StreamableHTTP MCP at **`/api/mcp`** (proxied through nginx).

Example `mcp.json` (Cursor / compatible clients):

```json
{
  "mcpServers": {
    "beskid-nexus": {
      "url": "https://<nexus-host>/api/mcp",
      "headers": {
        "Authorization": "Bearer <NEXUS_MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

When `NEXUS_MCP_AUTH_TOKEN` is unset, `/api/` is unauthenticated (development only).

## Health

Container healthcheck: `wget -q --spider http://127.0.0.1/api/health`. Map Coolify’s public domain to container port **80**.

## Local smoke test (this repo)

```bash
git submodule update --init compiler
podman compose up --build
# or: docker compose up --build (Podman exposes a Docker-compatible socket on macOS)
```

Superrepo checkout:

```bash
git submodule update --init beskid_nexus compiler
podman compose -f beskid_nexus/docker-compose.superrepo.yml up --build
```

Open `http://localhost/` — the UI auto-connects to the baked `compiler` index.

## Related applications

- [Docs site](../site/COOLIFY.md) — `https://beskid-lang.org`
- [Tracker](../beskid_tracker/COOLIFY.md) — roadmap / issues
