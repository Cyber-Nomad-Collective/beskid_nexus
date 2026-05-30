# Beskid Nexus

Graph-first public explorer for Beskid repositories — cached knowledge graphs, repo-scoped code documentation, and owner-gated catalog administration. Built on a trimmed [GitNexus](https://github.com/abhigyanpatwari/GitNexus) fork (`v1.6.5` — see [UPSTREAM.md](UPSTREAM.md)).

| Surface | Description |
|---------|-------------|
| Web UI | Navbar shell, repo selector, Sigma.js graph explorer (no catalog grid or local analyze) |
| MCP | StreamableHTTP at `/api/mcp` via `gitnexus serve` |
| Deploy | Docker / Coolify — [COOLIFY.md](COOLIFY.md) |

Normative contracts: [platform spec — Nexus](https://beskid-lang.org/platform-spec/tooling/nexus/).

## Checkout

```bash
git clone https://github.com/Cyber-Nomad-Collective/beskid_nexus.git
```

## Local development

Set `SESSION_SECRET` (32+ chars) and `AUTH_HUB_PUBLIC_URL` in the environment (see [COOLIFY.md](COOLIFY.md) for the full variable list).

**Terminal A — API server (port 8452):**

```bash
cd gitnexus-shared && bun install --frozen-lockfile && bun run build
cd ../gitnexus && bun install --frozen-lockfile && bun run build

export GITNEXUS_HOME="$PWD/.data/gitnexus"
export PORT=8452
export SESSION_SECRET="dev-secret-at-least-32-characters-long"
export AUTH_HUB_PUBLIC_URL="http://localhost:8090"
# Optional: code-doc pipeline (server-side only, invisible in public UI)
# export OPENROUTER_API_KEY="..."
# export NEXUS_DOC_MODEL="openrouter/free"
# export NEXUS_SPEC_ROOT="/path/to/site/website/src/content/docs/platform-spec"
node dist/cli/index.js serve --host 0.0.0.0 --port "$PORT"
```

**Terminal B — web dev (proxies `/api` → 8452):**

```bash
cd gitnexus-web && bun install && bun run dev
```

Open the Vite URL (typically `http://localhost:5173`).

### What to expect

- **`/`** loads the first **indexed** catalog entry by `sortOrder`, or an empty state with a sign-in CTA when none are indexed.
- **`?repo=<catalog-id>`** deep-links to a repository graph.
- **Public visitors** browse graphs and read `codeDoc` / `specLinks` on nodes (when the doc pipeline has run).
- **Signed-in GitHub users** who **own** a repo on GitHub see **Manage repo** (add, re-index, refresh docs, delete) and **Connect MCP**.
- **Instance operators** pair the auth hub once via setup (`NEXUS_SETUP_TOKEN`); repo CRUD is **not** limited to a global admin roster.

Pair with the shared [auth hub](../site/auth/README.md): hub **Admin → Pairing** (app `nexus`), then sign in via **Connect Beskid Auth**.

## Tests

```bash
cd gitnexus && bun run test test/unit/github-ownership.test.ts test/unit/repo-owner-admin.test.ts test/unit/code-doc-store.test.ts test/unit/spec-link-index.test.ts test/unit/code-doc-validator.test.ts
cd ../gitnexus-web && bun run test && bun run build
```

On macOS, LadybugDB native bindings may require the Linux optional package used in [Dockerfile](Dockerfile); route unit tests above avoid loading Ladybug at import time.

## Container (Podman or Docker)

```bash
cp .env.example .env   # SESSION_SECRET, AUTH_HUB_PUBLIC_URL, NEXUS_MCP_AUTH_TOKEN, etc.
podman compose up --build
```

Data persists in the `nexus-data` volume (`GITNEXUS_HOME=/data/gitnexus`). Graphs are indexed when **repo owners** add entries or GitHub push webhooks fire.

## MCP client

See [COOLIFY.md](COOLIFY.md) for `NEXUS_MCP_AUTH_TOKEN` and endpoint URL. In the web UI, signed-in owners use **Connect MCP** for the same-origin URL and Bearer header format.

## Auth

GitHub OAuth runs only on the shared [auth hub](../site/auth/README.md). Nexus stores a paired **service token** and signs users in via `/api/auth/hub-finish`.
