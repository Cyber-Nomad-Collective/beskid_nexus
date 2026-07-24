import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	// Authoritative E2E runner: `bun run test:e2e` (after `bun run test:e2e:install`).
	// Do not run these specs through Bun or Vitest.
	testDir: "./e2e",
	testIgnore: ["**/manual-record.spec.ts", "**/debug-issues.spec.ts"],
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5173",
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "bun run dev --host 127.0.0.1 --port 5173",
		url: "http://127.0.0.1:5173",
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
