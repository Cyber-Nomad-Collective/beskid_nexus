# Beskid Nexus

Interactive knowledge graph of the [Beskid compiler](https://github.com/Cyber-Nomad-Collective/beskid_compiler) workspace, built on a trimmed [GitNexus](https://github.com/abhigyanpatwari/GitNexus) fork (`v1.6.5` — see [UPSTREAM.md](UPSTREAM.md)).

| Surface | Description |
|---------|-------------|
| Web UI | Sigma.js explorer for the baked `compiler/` index |
| MCP | StreamableHTTP at `/api/mcp` via `gitnexus serve` |
| Deploy | Docker / Coolify from the Beskid superrepo — [COOLIFY.md](COOLIFY.md) |

## Superrepo checkout

```bash
git submodule update --init beskid_nexus compiler
```

## Local development

Terminal 1 — index and serve (from `beskid_nexus/gitnexus` after `npm ci && npm run build`):

```bash
export GITNEXUS_HOME="$HOME/.gitnexus-beskid"
gitnexus analyze ../../compiler --skip-embeddings --skip-agents-md --skip-git
gitnexus serve --host 127.0.0.1 --port 4747
```

Terminal 2 — web (proxies `/api` to the server):

```bash
cd gitnexus-web && npm ci && npm run dev
```

Open the Vite URL; the UI bootstraps the `compiler` repo automatically.

## Docker

From the **superrepo root** (requires `compiler/` submodule):

```bash
docker compose -f beskid_nexus/docker-compose.yml up --build
```

## MCP client

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

## Layout

| Path | Role |
|------|------|
| `gitnexus/` | CLI — `analyze`, `serve`, MCP |
| `gitnexus-shared/` | Shared types |
| `gitnexus-web/` | Beskid Nexus UI (`src/config`, `src/hooks/useServerBootstrap.ts`) |
| `Dockerfile` | Superrepo build (context = repo root) |
| `nginx/` | Static UI + `/api` proxy |
