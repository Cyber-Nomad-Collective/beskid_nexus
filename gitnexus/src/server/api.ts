/**
 * HTTP API Server
 *
 * REST API for browser-based clients to query the local .gitnexus/ index.
 * Also hosts the MCP server over StreamableHTTP for remote AI tool access.
 *
 * Security: binds to localhost by default (use --host to override).
 * CORS is restricted to localhost, private/LAN networks, and the deployed site.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { closeLbug } from "../core/lbug/lbug-adapter.js";
import { flushLoggerSync, logger } from "../core/logger.js";
import { LocalBackend } from "../mcp/local/local-backend.js";
import { listRegisteredRepos } from "../storage/repo-manager.js";
import { JobManager } from "./analyze-job.js";
import { mountMCPEndpoints } from "./mcp-http.js";
import {
	mountGithubWebhook,
	mountNexusRoutes,
} from "./nexus/mount-nexus-routes.js";
import { ensureSpecLinkIndex } from "./nexus/spec-link-index.js";
import { mountMetricsRoute, observabilityMiddleware } from "./observability.js";
import {
	registerAnalysisRoutes,
	registerSystemRoutes,
} from "./api/lifecycle-streaming.js";
import { registerGraphSearchRoutes } from "./api/graph-search.js";
import { registerProcessDiffRoutes } from "./api/processes-diffs.js";
import {
	registerWebUI,
	resolveWebDistDir,
} from "./api/middleware-errors.js";
import { isAllowedOrigin } from "./api/contracts.js";

export { isAllowedOrigin } from "./api/contracts.js";
export {
	ClientDisconnectedError,
	isIgnorableGraphQueryError,
} from "./api/graph-search.js";
export { SPA_FALLBACK_REGEX } from "./api/contracts.js";
export {
	resolveWebDistDir,
	landingPageHtml,
	staticCacheControlSetHeaders,
	registerWebUI,
} from "./api/middleware-errors.js";
export {
	writeNdjsonRecord,
	streamGraphNdjson,
} from "./api/graph-search.js";
export { handleFileRequest } from "./api/middleware-errors.js";

export const createServer = async (
	port: number,
	host: string = "127.0.0.1",
) => {
	const app = express();
	app.disable("x-powered-by");
	app.use(observabilityMiddleware);
	mountMetricsRoute(app);

	// Trust X-Forwarded-* headers only when the connection comes from the
	// local loopback or RFC1918 private/link-local addresses — exactly the
	// origins the CORS allowlist accepts. Without this, every request behind
	// any reverse proxy / Docker bridge counts as the same `req.ip` and a
	// single user can trip the per-IP rate limiter for everyone.
	//
	// SCOPE: this setting is process-wide. Every middleware and route in this
	// Express app sees req.ip resolved from X-Forwarded-For when the upstream
	// hop is in the trusted set above — not just the rate-limited routes.
	// Future IP-based middleware (audit logging, IP-bound authz) inherits this
	// behavior.
	//
	// CLOUD-DEPLOY CAVEAT: a public cloud LB (AWS ALB, Cloudflare, Fly.io
	// edge, CGNAT 100.64/10) is NOT in the trusted set. In those topologies
	// req.ip will collapse to the LB hop IP for every request and the per-IP
	// rate limiter degrades to per-server. Add an explicit env-var override
	// and document the cloud-deploy story before binding to a non-loopback
	// host in those topologies (tracked as a follow-up; not blocking for the
	// local-bound default).
	app.set("trust proxy", "loopback, linklocal, uniquelocal");

	// CORS: allow localhost, private/LAN networks, and the deployed site.
	// Non-browser requests (curl, server-to-server) have no origin and are allowed.
	// Disallowed origins get the response without Access-Control-Allow-Origin,
	// so the browser blocks it. We pass `false` instead of throwing an Error to
	// avoid crashing into Express's default error handler (which returned 500).
	app.use(
		cors({
			origin: (origin, callback) => {
				callback(null, isAllowedOrigin(origin));
			},
		}),
	);

	// Initialize MCP backend early (needed for Nexus routes and analyze jobs).
	const backend = new LocalBackend();
	await backend.init();
	void ensureSpecLinkIndex().catch((err) => {
		logger.warn({ err }, "Failed to build spec link index at boot");
	});
	const cleanupMcp = mountMCPEndpoints(app, backend);
	const jobManager = new JobManager();

	const activeRepoPaths = new Set<string>();
	const acquireRepoLock = (repoPath: string): string | null => {
		if (activeRepoPaths.has(repoPath)) {
			return `Another job is already active for this repository`;
		}
		activeRepoPaths.add(repoPath);
		return null;
	};
	const releaseRepoLock = (repoPath: string): void => {
		activeRepoPaths.delete(repoPath);
	};

	const nexusDeps = { jobManager, backend, acquireRepoLock, releaseRepoLock };
	mountGithubWebhook(app, nexusDeps);

	app.use(express.json({ limit: "10mb" }));

	const apiAuthToken = process.env.NEXUS_MCP_AUTH_TOKEN?.trim();
	const isPublicApiPath = (p: string): boolean => {
		if (p === "/api/health") return true;
		if (p.startsWith("/api/auth")) return true;
		if (p === "/api/catalog" || p.startsWith("/api/catalog/")) return true;
		if (p === "/api/admin/setup/status") return true;
		if (p === "/api/admin/setup") return true;
		if (p.startsWith("/api/admin/")) return true;
		if (p === "/api/webhooks/github") return true;
		return false;
	};

	if (apiAuthToken) {
		app.use((req, res, next) => {
			if (!req.path.startsWith("/api") || isPublicApiPath(req.path)) {
				next();
				return;
			}
			const header = req.headers.authorization;
			if (header === `Bearer ${apiAuthToken}`) {
				next();
				return;
			}
			res.status(401).json({ error: "Unauthorized" });
		});
	}

	mountNexusRoutes(app, nexusDeps);

	// Support Chromium Private Network Access (required since Chrome 130+).
	// Without this header, Chrome/Edge/Brave/Arc block public->loopback requests
	// which breaks bridge mode entirely.
	app.use((_req, res, next) => {
		res.setHeader("Access-Control-Allow-Private-Network", "true");
		next();
	});

	// Handle PNA preflight: Chromium sends Access-Control-Request-Private-Network
	// on OPTIONS requests and expects the allow header in the response.
	// Note: the actual Allow-Private-Network header is already set by the global
	// middleware above, so we just need to call next() here.
	app.options("*", (_req, _res, next) => {
		next();
	});

	/**
	 * Maximum time the hold-queue will wait for an active analysis job to complete.
	 * Must stay in sync with the frontend's `fetchRepoInfo({ awaitAnalysis: true })` timeout.
	 */
	const HOLD_QUEUE_TIMEOUT_SECS = 300; // 5 minutes

	// Helper: resolve a repo by name from the global registry, or default to first.
	// Pass `req` to enable early exit if the client disconnects during the hold-queue wait.
	const resolveRepo = async (
		repoName?: string,
		isRetry = false,
		req?: any,
	): Promise<any> => {
		const repos = await listRegisteredRepos();
		let found = null;

		// Normalize: if a full path is passed, extract just the basename.
		// e.g. "C:\Users\LENOVO\.gitnexus\repos\todo.txt-cli" -> "todo.txt-cli"
		const normalizedName = repoName ? path.basename(repoName) : undefined;

		if (normalizedName) {
			found =
				repos.find((r) => r.name === normalizedName) ||
				repos.find((r) => r.name.toLowerCase() === normalizedName.toLowerCase()) ||
				null;
		} else if (repos.length > 0) {
			found = repos[0]; // default to first repo
		}

		// If not yet in the registry, check whether a background job is actively cloning or
		// analyzing this repo. Hold the connection open (up to 5 minutes) until it completes.
		// We only wait for in-progress jobs ('queued'|'cloning'|'analyzing') — a 'complete' job
		// whose repo is still missing means the registry sync failed; the fallback below handles it.
		if (!found && normalizedName) {
			const lower = normalizedName.toLowerCase();

			// Track client disconnect to cancel the wait early
			let clientGone = false;
			req?.on("close", () => {
				clientGone = true;
			});

			for (const job of jobManager.listJobs()) {
				const isMatch =
					job.repoName?.toLowerCase() === lower ||
					(job.repoUrl &&
						path.basename(job.repoUrl).replace(".git", "").toLowerCase() === lower) ||
					(job.repoPath && path.basename(job.repoPath).toLowerCase() === lower);

				if (isMatch && ["queued", "cloning", "analyzing"].includes(job.status)) {
					if (process.env.DEBUG) {
						// Sanitize user-controlled values to prevent log injection (CodeQL js/log-injection).
						logger.debug(
							{
								jobId: String(job.id).replace(/[\r\n]/g, " "),
								repoName: String(normalizedName).replace(/[\r\n]/g, " "),
							},
							"[debug] resolveRepo waiting for active job",
						);
					}
					for (let wait = 0; wait < HOLD_QUEUE_TIMEOUT_SECS; wait++) {
						if (clientGone) return null; // client disconnected — stop polling
						const currentJob = jobManager.getJob(job.id);
						if (!currentJob || currentJob.status === "failed") break;
						if (currentJob.status === "complete") {
							await backend.init();
							const freshRepos = await listRegisteredRepos();
							return freshRepos.find((r) => r.name === normalizedName) || null;
						}
						await new Promise((r) => setTimeout(r, 1000));
					}
					// Timed out — signal to the caller with a specific message
					return { __timedOut: true, repoName: normalizedName };
				}
			}
		}

		// Emergency fallback: re-sync the registry to handle Windows file-system race conditions
		// (e.g. registry file not yet flushed after clone completes).
		if (!found && normalizedName && !isRetry) {
			if (process.env.DEBUG) {
				// Sanitize user-controlled values to prevent log injection (CodeQL js/log-injection).
				logger.debug(
					{ repoName: String(normalizedName).replace(/[\r\n]/g, " ") },
					"[debug] resolveRepo 404, triggering deep init",
				);
			}
			await backend.init();
			return await resolveRepo(normalizedName, true, req);
		}

		return found;
	};

	const routeDeps = {
		app,
		backend,
		jobManager,
		acquireRepoLock,
		releaseRepoLock,
		resolveRepo,
	};
	registerSystemRoutes(routeDeps);
	registerGraphSearchRoutes(routeDeps);
	registerProcessDiffRoutes(routeDeps);
	const embedJobManager = registerAnalysisRoutes(routeDeps);

	// ── Web UI (served at root) ───────────────────────────────────────

	// Resolve the gitnexus-web dist directory relative to this file's location.
	// In the published package: <pkg>/dist/server/api.js → <pkg>/web/
	// In dev (tsx):            gitnexus/src/server/api.ts → gitnexus-web/dist/
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const webDistDir = path.resolve(__dirname, "..", "..", "web");
	const devWebDistDir = path.resolve(
		__dirname,
		"..",
		"..",
		"..",
		"gitnexus-web",
		"dist",
	);
	const staticDir = await resolveWebDistDir(webDistDir, devWebDistDir);
	registerWebUI(app, staticDir);

	// Global error handler — catch anything the route handlers miss
	app.use(
		(
			err: any,
			_req: express.Request,
			res: express.Response,
			_next: express.NextFunction,
		) => {
			logger.error({ err }, "Unhandled error:");
			res.status(500).json({ error: "Internal server error" });
		},
	);

	// Wrap listen in a promise so errors (EADDRINUSE, EACCES, etc.) propagate
	// to the caller instead of crashing with an unhandled 'error' event.
	await new Promise<void>((resolve, reject) => {
		const server = app.listen(port, host, () => {
			const displayHost = host === "::" || host === "0.0.0.0" ? "localhost" : host;
			console.log(`GitNexus server running on http://${displayHost}:${port}`);
			resolve();
		});
		server.on("error", (err) => reject(err));

		// Graceful shutdown — close Express + LadybugDB cleanly. Pino's default
		// destination is `sync: false` (buffered); `flushLoggerSync()` before
		// `process.exit` so records emitted during cleanup reach stderr.
		const shutdown = async () => {
			console.log("\nShutting down...");
			server.close();
			jobManager.dispose();
			embedJobManager.dispose();
			await cleanupMcp();
			await closeLbug();
			await backend.disconnect();
			const { flushLoggerSync } = await import("../core/logger.js");
			flushLoggerSync();
			process.exit(0);
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);

		// Catch-all crash guards (mirrors startMCPServer in mcp/server.ts).
		// Pino v10's default destination is buffered (`sync: false`) — call
		// `flushLoggerSync()` after logging and before triggering shutdown
		// so the crash record reaches stderr regardless of how cleanup goes.
		// Worker-thread transports (pino-pretty under TTY) handle their own
		// flush on process exit in v10. `pino.final` was removed in v10
		// because the new transport architecture made it unnecessary.
		let shuttingDown = false;
		process.on("uncaughtException", (err) => {
			logger.error({ err }, "GitNexus uncaughtException");
			flushLoggerSync();
			if (!shuttingDown) {
				shuttingDown = true;
				shutdown().catch(() => {});
			}
		});
		process.on("unhandledRejection", (reason: unknown) => {
			// Availability-first: log the rejection without exiting.
			const err = reason instanceof Error ? reason : new Error(String(reason));
			logger.error({ err }, "GitNexus unhandledRejection");
		});
	});
};
