# Coolify: Beskid Nexus

Application: **beskid nexus** (`Cyber-Nomad-Collective/beskid_nexus`, branch `main`, repository root).

## Compose entry

Use [`docker-compose.yml`](docker-compose.yml) or [`infra/docker-compose.yml`](infra/docker-compose.yml). **Build context is this repository root** (`context: .`, `dockerfile: Dockerfile`).

Standalone builds set `FETCH_COMPILER=1` so the image clones [beskid_compiler](https://github.com/Cyber-Nomad-Collective/beskid_compiler) during the indexer stage (no `compiler/` submodule in this repo).

For the Beskid superrepo checkout, use [`docker-compose.superrepo.yml`](docker-compose.superrepo.yml) (`context: ..`, `dockerfile: beskid_nexus/Dockerfile`) so the image indexes the sibling `compiler/` tree at the superrepo root.

## Build

- Image: [`Dockerfile`](Dockerfile) — `gitnexus` CLI + web UI (`gitnexus/web/`), `gitnexus analyze` on the compiler tree, **`gitnexus serve` on port 80** (API, MCP, and static UI; no nginx).
- Graph data is **baked into the image**; redeploy after updating the compiler source (superrepo `compiler/` submodule pointer or `COMPILER_GIT_REF` build arg) to refresh.

Optional build args (standalone clone):

| Arg | Default | Purpose |
|-----|---------|---------|
| `COMPILER_GIT_URL` | `https://github.com/Cyber-Nomad-Collective/beskid_compiler.git` | Compiler repo to index |
| `COMPILER_GIT_REF` | `main` | Branch or tag to clone |

## Runtime secrets

| Variable | Required | Notes |
|----------|----------|--------|
| `NEXUS_MCP_AUTH_TOKEN` | recommended (production) | Bearer token for `/api/*` (including MCP). `/api/health` stays open. Leave empty for local smoke only. |
| `GITNEXUS_HOME` | optional | Default `/data/gitnexus` (pre-populated in image) |
| `PORT` | optional | `gitnexus serve` listen port; default `80` |
| `GITNEXUS_SERVE_HOST` | optional | Bind address; default `0.0.0.0` |

## MCP over HTTP

GitNexus `serve` exposes StreamableHTTP MCP at **`/api/mcp`** on the same port as the UI.

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
podman compose up --build
# or: docker compose up --build
```

Superrepo checkout (indexes `../compiler`):

```bash
git submodule update --init compiler
podman compose -f beskid_nexus/docker-compose.superrepo.yml up --build
```

Open `http://localhost/` — the UI auto-connects to the baked `compiler` index.

## Related applications

- [Docs site](../site/COOLIFY.md) — `https://beskid-lang.org`
- [Tracker](../beskid_tracker/COOLIFY.md) — roadmap / issues
