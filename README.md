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

Copy [`.env.example`](.env.example) to `.env` and set `SESSION_SECRET` (32+ chars) and `AUTH_HUB_PUBLIC_URL`.

**Terminal A — API server (port 8452):**

```bash
cd gitnexus-shared && bun install --frozen-lockfile && bun run build
cd ../gitnexus && bun install --frozen-lockfile && bun run build

export GITNEXUS_HOME="$PWD/.data/gitnexus"
export PORT=8452
export SESSION_SECRET="dev-secret-at-least-32-characters-long"
export AUTH_HUB_PUBLIC_URL="http://localhost:8090"
node dist/cli/index.js serve --host 0.0.0.0 --port "$PORT"
```

**Terminal B — web dev (proxies `/api` → 8452):**

```bash
cd gitnexus-web && bun install && bun run dev
```

Open the Vite URL (typically `http://localhost:5173`). On first visit, complete **Connect Beskid Auth** (pair with the hub using a code from hub **Admin → Pairing**), sign in as an admin, and add repository links under **Manage catalog**.

## Container (Podman or Docker)

```bash
cp .env.example .env   # SESSION_SECRET, AUTH_HUB_PUBLIC_URL, NEXUS_MCP_AUTH_TOKEN, etc.
podman compose up --build
```

Data persists in the `nexus-data` volume (`GITNEXUS_HOME=/data/gitnexus`). First boot starts with an empty catalog until an admin adds repositories.

## MCP client

See [COOLIFY.md](COOLIFY.md) for `NEXUS_MCP_AUTH_TOKEN` and endpoint URL.

## Auth

GitHub OAuth runs only on the shared [auth hub](../site/auth/README.md). Nexus stores a paired **service token** and signs users in via `/api/auth/hub-finish`.
