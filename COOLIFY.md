# Coolify: Beskid Nexus

Application: **beskid nexus** (`Cyber-Nomad-Collective/beskid`, branch `main`, base directory `/beskid_nexus`).

## Compose entry

Use [`docker-compose.yml`](docker-compose.yml) or [`infra/docker-compose.yml`](infra/docker-compose.yml). **Build context is the superrepo root** (not `beskid_nexus/` alone).

## Compiler submodule (required)

Unlike the docs site and tracker, the Nexus image **indexes `compiler/` at build time**. Coolify must provide a checkout that includes the compiler tree:

1. Enable **`compiler` submodule** init on clone (non-shallow if SHA fetch fails).
2. Or use a full clone with `git submodule update --init compiler`.
3. Build fails fast if `compiler/Cargo.toml` is missing.

Disable unrelated shallow submodules when possible (`pckg`, `references/bsharp`, etc.) to speed clones.

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

## Local smoke test (superrepo root)

```bash
git submodule update --init compiler
docker compose -f beskid_nexus/docker-compose.yml up --build
```

Open `http://localhost/` — the UI auto-connects to the baked `compiler` index.

## Related applications

- [Docs site](../site/COOLIFY.md) — `https://beskid-lang.org`
- [Tracker](../beskid_tracker/COOLIFY.md) — roadmap / issues
