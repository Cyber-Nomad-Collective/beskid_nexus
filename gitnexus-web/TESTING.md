# gitnexus-web test runners

Authoritative commands (do **not** use bare `bun test` — Bun’s built-in runner has no jsdom and also picks up Playwright specs):

| Suite | Command | Runner |
| --- | --- | --- |
| Unit | `bun run test` | Vitest + jsdom (`test/**/*.test.{ts,tsx}`) |
| Unit (watch) | `bun run test:watch` | Vitest |
| Unit (coverage) | `bun run test:coverage` | Vitest |
| E2E | `bun run test:e2e` | Playwright (`e2e/**`) |
| E2E browsers | `bun run test:e2e:install` | `playwright install chromium` |
| Package gate | `bun run test:gate` | unit then E2E (totals from each runner) |
| Gate (unit + E2E) | `bun run test:gate` | Vitest then Playwright |

## Unit

```bash
bun --cwd beskid_nexus/gitnexus-web run test
```

Requires Vitest (via the `test` script). Environment: jsdom (`vitest.config.ts`).

## E2E

```bash
bun --cwd beskid_nexus/gitnexus-web run test:e2e:install   # once per machine / Playwright upgrade
bun --cwd beskid_nexus/gitnexus-web run test:e2e
```

Playwright starts Vite (`webServer` in `playwright.config.ts`). Specs that need a live gitnexus backend skip when the API is unreachable; graph-first specs mock the catalog/API and always run. Debug/manual harnesses are ignored unless invoked explicitly with `DEBUG_E2E=1` / `PWDEBUG=1`.
