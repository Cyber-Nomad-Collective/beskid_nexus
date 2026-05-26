# Beskid Nexus

Interactive knowledge graph of the [Beskid compiler](https://github.com/Cyber-Nomad-Collective/beskid_compiler) workspace, built on a trimmed [GitNexus](https://github.com/abhigyanpatwari/GitNexus) fork.

- **Web UI** — explore compiler structure (modules, calls, dependencies) in the browser
- **MCP over HTTP** — connect editors via `gitnexus serve` at `/api/mcp` (StreamableHTTP)
- **Deploy** — Coolify / Docker from the Beskid superrepo (see [COOLIFY.md](COOLIFY.md))

## Superrepo checkout

```bash
git submodule update --init beskid_nexus compiler
```

## Local development (superrepo root)

```bash
cd beskid_nexus/gitnexus && npm ci && npm run build
cd ../gitnexus-shared && npm ci && npm run build
cd ../gitnexus-web && npm ci && npm run dev
# In another terminal:
cd gitnexus && node dist/cli/index.js analyze ../../compiler --skip-embeddings --skip-agents-md --skip-git
node dist/cli/index.js serve --host 127.0.0.1 --port 4747
```

Open the Vite dev server; it auto-connects to `http://127.0.0.1:4747` for the `compiler` repo.

## Docker (production-shaped)

From the **superrepo root** (requires `compiler/` submodule):

```bash
docker compose -f beskid_nexus/docker-compose.yml up --build
```

## MCP client example

```json
{
  "mcpServers": {
    "beskid-nexus": {
      "url": "https://<your-nexus-host>/api/mcp",
      "headers": {
        "Authorization": "Bearer <NEXUS_MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

See [COOLIFY.md](COOLIFY.md) for auth, env vars, and Coolify settings.
