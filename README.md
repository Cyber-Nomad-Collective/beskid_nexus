# Beskid Nexus

Interactive knowledge graph explorer for Beskid and related repositories, built on a trimmed [GitNexus](https://github.com/abhigyanpatwari/GitNexus) fork (`v1.6.5` — see [UPSTREAM.md](UPSTREAM.md)).

| Surface | Description |
|---------|-------------|
| Web UI | Catalog of curated repos + Sigma.js graph explorer |
| MCP | StreamableHTTP at `/api/mcp` via `gitnexus serve` |
| Deploy | Docker / Coolify — [COOLIFY.md](COOLIFY.md) |

## Checkout

```bash
git clone https://github.com/Cyber-Nomad-Collective/beskid_nexus.git
```

## Local development

Copy [`.env.example`](.env.example) to `.env` and set at least `SESSION_SECRET` (32+ chars) for OAuth.

**Terminal A — API server (port 8452):**

```bash
cd gitnexus-shared && bun install && bun run build
cd ../gitnexus && bun install && bun run build

export GITNEXUS_HOME="$PWD/.data/gitnexus"
export PORT=8452
export SESSION_SECRET="dev-secret-at-least-32-characters-long"
node dist/cli/index.js serve --host 0.0.0.0 --port "$PORT"
```

**Terminal B — web dev (proxies `/api` → 8452):**

```bash
cd gitnexus-web && bun install && bun run dev
```

Open the Vite URL (typically `http://localhost:5173`). On first visit, complete the GitHub OAuth setup wizard, sign in as an admin, and add repository links under **Manage catalog**. Each entry is cloned and indexed at runtime; data persists under `GITNEXUS_HOME`.

## Container (Podman or Docker)

```bash
cp .env.example .env   # set SESSION_SECRET, OAuth, NEXUS_MCP_AUTH_TOKEN, etc.
podman compose up --build
```

Data persists in the `nexus-data` volume (`GITNEXUS_HOME=/data/gitnexus`). First boot starts with an empty catalog until an admin adds repositories.

## MCP client

```json
{
  "mcpServers": {
    "beskid-nexus": {
      "url": "https://<nexus-host>:8452/api/mcp",
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
| `gitnexus/` | CLI — `analyze`, `serve`, MCP; ships built UI under `web/` |
| `gitnexus-shared/` | Shared types |
| `gitnexus-web/` | Beskid Nexus UI (catalog, admin, graph) |
| `gitnexus/src/server/nexus/` | Catalog, OAuth, webhooks |
| `Dockerfile` | Runtime-only image (`gitnexus serve` on 8452) |
