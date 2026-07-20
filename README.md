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
# export NEXUS_OPEN_SPEC_CATALOG="/path/to/beskid/openspec/catalog.json"
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

Authoritative runners for `gitnexus-web` (see also
[gitnexus-web/TESTING.md](gitnexus-web/TESTING.md)). Do **not** use raw
`bun test` — it has no jsdom and is blocked via `bunfig.toml` preload:

| Suite | Command | Runner |
|-------|---------|--------|
| Unit (jsdom) | `cd gitnexus-web && bun run test` (alias: `bun run test:unit`) | Vitest + jsdom |
| E2E | `cd gitnexus-web && bun run test:e2e:install && bun run test:e2e` | Playwright (Chromium) |
| Both (package gate) | `cd gitnexus-web && bun run test:gate` | unit then E2E; prints each runner's totals |

Playwright starts the Vite dev server via `playwright.config.ts`. Backend-dependent
specs skip cleanly when `gitnexus serve` is unavailable; mock-based specs (e.g.
`e2e/graph-first.spec.ts`) run without a live backend. Manual/debug harnesses are
`testIgnore`d from `test:e2e`.

```bash
cd gitnexus && bun run test test/unit/github-ownership.test.ts test/unit/repo-owner-admin.test.ts test/unit/code-doc-store.test.ts test/unit/spec-link-index.test.ts test/unit/code-doc-validator.test.ts
cd ../gitnexus-web && bun run test && bun run build
# Optional E2E (requires Chromium once): bun run test:e2e:install && bun run test:e2e
```

On macOS, LadybugDB native bindings may require the Linux optional package used in [Dockerfile](Dockerfile); route unit tests above avoid loading Ladybug at import time.

Root release-gate wiring that invokes these package commands lives in CYB-93.

## Container (Podman or Docker)

```bash
cp .env.example .env   # SESSION_SECRET, AUTH_HUB_PUBLIC_URL, NEXUS_MCP_AUTH_TOKEN, etc.
docker buildx build \
  --build-context openspec=../openspec \
  --tag beskid-nexus:local \
  --load .
```

The root delivery workflow supplies the same `openspec` named context while
keeping `beskid_nexus` as the primary Docker context. The resulting image sets
`NEXUS_OPEN_SPEC_CATALOG=/app/openspec/catalog.json`; operators may override
that variable with an explicit read-only runtime mount when testing another
catalog. Data persists in the `nexus-data` volume
(`GITNEXUS_HOME=/data/gitnexus`). Graphs are indexed when **repo owners** add
entries or GitHub push webhooks fire.

## MCP client

See [COOLIFY.md](COOLIFY.md) for `NEXUS_MCP_AUTH_TOKEN` and endpoint URL. In the web UI, signed-in owners use **Connect MCP** for the same-origin URL and Bearer header format.

## Auth

GitHub OAuth runs only on the shared [auth hub](../site/auth/README.md). Nexus stores a paired **service token** and signs users in via `/api/auth/hub-finish`.
