import { createRequire } from "node:module";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { resolveUiReactAliases } from "./vite.resolve-beskid-ui";

const _require = createRequire(import.meta.url);
const gitnexusPkg = _require("../gitnexus/package.json");

export default defineConfig({
	plugins: [react()],
	define: {
		__REQUIRED_NODE_VERSION__: JSON.stringify(
			gitnexusPkg.engines.node.replace(/[>=^~\s]/g, ""),
		),
	},
	resolve: {
		// Exact-match aliases (array form) so `gitnexus-shared/test-helpers` is not
		// swallowed by a file-level `gitnexus-shared` → index.ts mapping.
		alias: [
			{
				find: /^gitnexus-shared$/,
				replacement: path.resolve(__dirname, "../gitnexus-shared/src/index.ts"),
			},
			{
				find: /^gitnexus-shared\/test-helpers$/,
				replacement: path.resolve(
					__dirname,
					"../gitnexus-shared/src/test-helpers.ts",
				),
			},
			{ find: "@", replacement: path.resolve(__dirname, "./src") },
			...Object.entries(resolveUiReactAliases()).map(([find, replacement]) => ({
				find,
				replacement,
			})),
			{
				find: "@anthropic-ai/sdk/lib/transform-json-schema",
				replacement: path.resolve(
					__dirname,
					"node_modules/@anthropic-ai/sdk/lib/transform-json-schema.mjs",
				),
			},
			{
				find: "mermaid",
				replacement: path.resolve(
					__dirname,
					"node_modules/mermaid/dist/mermaid.esm.min.mjs",
				),
			},
		],
	},
	test: {
		// Authoritative unit runner: `bun run test` (not bare `bun test`).
		// E2E lives under e2e/ and must only run via `bun run test:e2e`.
		globals: true,
		environment: "jsdom",
		setupFiles: ["./test/setup.ts"],
		include: ["test/**/*.test.{ts,tsx}"],
		exclude: ["e2e/**", "node_modules/**", "dist/**"],
		testTimeout: 15000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.{ts,tsx}"],
			exclude: [
				"src/workers/**", // Web workers (require worker env)
				"src/core/lbug/**", // WASM (requires SharedArrayBuffer)
				"src/core/tree-sitter/**", // WASM (requires tree-sitter binaries)
				"src/core/embeddings/**", // WASM (requires ML model)
				"src/main.tsx", // Entry point
				"src/vite-env.d.ts", // Type declarations
			],
			// Thresholds set to the post-vitest-4 baseline (AST-aware remapping
			// measures coverage more accurately than the old istanbul-style mapping,
			// so the same 220 tests now report slightly lower percentages). These
			// are soft floors for regression detection, not coverage targets.
			thresholds: {
				statements: 9,
				branches: 4,
				functions: 7,
				lines: 9,
			},
		},
	},
});
