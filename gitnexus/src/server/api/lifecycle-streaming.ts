import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type express from "express";

import {
	closeLbug,
	executeQuery,
	executeWithReusedStatement,
	flushWAL,
	withLbugDb,
} from "../../core/lbug/lbug-adapter.js";
import { logger } from "../../core/logger.js";
import {
	getStoragePath,
	listRegisteredRepos,
	loadMeta,
} from "../../storage/repo-manager.js";
import { JobManager } from "../analyze-job.js";
import { cloneOrPull, extractRepoName, getCloneDir } from "../git-clone.js";
import { createRouteLimiter } from "../validation.js";
import type { ServerRouteDeps } from "./contracts.js";
import { requestedRepo } from "./middleware-errors.js";

const _require = createRequire(import.meta.url);
const pkg = _require("../../../package.json");

export const mountSSEProgress = (
	app: express.Express,
	routePath: string,
	jm: JobManager,
) => {
	app.get(routePath, (req, res) => {
		const job = jm.getJob(req.params.jobId);
		if (!job) {
			res.status(404).json({ error: "Job not found" });
			return;
		}

		let eventId = 0;
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});

		// Send current state immediately
		eventId++;
		res.write(`id: ${eventId}\ndata: ${JSON.stringify(job.progress)}\n\n`);

		// If already terminal, send event and close
		if (job.status === "complete" || job.status === "failed") {
			eventId++;
			res.write(
				`id: ${eventId}\nevent: ${job.status}\ndata: ${JSON.stringify({
					repoName: job.repoName,
					error: job.error,
				})}\n\n`,
			);
			res.end();
			return;
		}

		// Heartbeat to detect zombie connections
		const heartbeat = setInterval(() => {
			try {
				res.write(":heartbeat\n\n");
			} catch {
				clearInterval(heartbeat);
				unsubscribe();
			}
		}, 30_000);

		// Subscribe to progress updates
		const unsubscribe = jm.onProgress(job.id, (progress) => {
			try {
				eventId++;
				if (progress.phase === "complete" || progress.phase === "failed") {
					const eventJob = jm.getJob(req.params.jobId);
					res.write(
						`id: ${eventId}\nevent: ${progress.phase}\ndata: ${JSON.stringify({
							repoName: eventJob?.repoName,
							error: eventJob?.error,
						})}\n\n`,
					);
					clearInterval(heartbeat);
					res.end();
					unsubscribe();
				} else {
					res.write(`id: ${eventId}\ndata: ${JSON.stringify(progress)}\n\n`);
				}
			} catch {
				clearInterval(heartbeat);
				unsubscribe();
			}
		});

		req.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
	});
};


export const registerSystemRoutes = (deps: ServerRouteDeps): void => {
	const { app, backend, jobManager, acquireRepoLock, releaseRepoLock, resolveRepo } = deps;

	// Lightweight healthcheck for Docker/orchestrator probes (#1147).
	// Returns immediately so container managers do not confuse a long-lived
	// SSE stream with an unhealthy server.
	app.get("/api/health", (_req, res) => {
		res.json({ status: "ok" });
	});

	// SSE heartbeat — clients connect to detect server liveness instantly.
	// When the server shuts down, the TCP connection drops and the client's
	// EventSource fires onerror immediately (no polling delay).
	app.get("/api/heartbeat", (_req, res) => {
		// Use res.set() instead of res.writeHead() to preserve CORS headers from middleware
		res.set({
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.flushHeaders();
		// Send initial ping so the client knows it connected
		res.write(":ok\n\n");

		// Keep-alive ping every 15s to prevent proxy/firewall timeout
		const interval = setInterval(() => res.write(":ping\n\n"), 15_000);

		_req.on("close", () => clearInterval(interval));
	});

	// Server info: version and launch context (npx / global / local dev)
	app.get("/api/info", (_req, res) => {
		const execPath = process.env.npm_execpath ?? "";
		const argv0 = process.argv[1] ?? "";
		let launchContext: "npx" | "global" | "local";
		if (
			execPath.includes("npx") ||
			argv0.includes("_npx") ||
			process.env.npm_config_prefix?.includes("_npx")
		) {
			launchContext = "npx";
		} else if (argv0.includes("node_modules")) {
			launchContext = "local";
		} else {
			launchContext = "global";
		}
		res.json({
			version: pkg.version,
			launchContext,
			nodeVersion: process.version,
		});
	});

	// List all registered repos
	app.get("/api/repos", async (_req, res) => {
		try {
			const repos = await listRegisteredRepos();
			res.json(
				repos.map((r) => ({
					name: r.name,
					path: r.path,
					remoteUrl: r.remoteUrl,
					indexedAt: r.indexedAt,
					lastCommit: r.lastCommit,
					stats: r.stats,
				})),
			);
		} catch (err: any) {
			res.status(500).json({ error: err.message || "Failed to list repos" });
		}
	});

	// Get repo info
	app.get("/api/repo", async (req, res) => {
		try {
			const entry = await resolveRepo(requestedRepo(req), false, req);
			if (!entry) {
				res
					.status(404)
					.json({ error: "Repository not found. Run: gitnexus analyze" });
				return;
			}
			// Timed out waiting for an active analysis job
			if (entry.__timedOut) {
				res.status(503).json({
					error: `Repository analysis for "${entry.repoName}" is taking longer than expected. Please try again in a moment.`,
				});
				return;
			}
			const meta = await loadMeta(entry.storagePath);
			res.json({
				name: entry.name,
				repoPath: entry.path,
				indexedAt: meta?.indexedAt ?? entry.indexedAt,
				stats: meta?.stats ?? entry.stats ?? {},
			});
		} catch (err: any) {
			res.status(500).json({ error: err.message || "Failed to get repo info" });
		}
	});

	// Delete a repo — removes index, clone dir (if any), and unregisters it
	// Rate-limited (CodeQL js/missing-rate-limiting): destructive operation
	// doing fs.rm of clone + storage dirs. Default 60 rpm/IP is generous for
	// delete; tighten if abuse is observed.
	app.delete("/api/repo", createRouteLimiter(), async (req, res) => {
		try {
			const repoName = requestedRepo(req);
			if (!repoName) {
				res.status(400).json({ error: "Missing repo name" });
				return;
			}
			const entry = await resolveRepo(repoName);
			if (!entry) {
				res.status(404).json({ error: "Repository not found" });
				return;
			}

			// Acquire repo lock — prevents deleting while analyze/embed is in flight
			const lockKey = getStoragePath(entry.path);
			const lockErr = acquireRepoLock(lockKey);
			if (lockErr) {
				res.status(409).json({ error: lockErr });
				return;
			}

			try {
				// Close any open LadybugDB handle before deleting files
				try {
					await closeLbug();
				} catch {}

				// 1. Delete the .gitnexus index/storage directory
				const storagePath = getStoragePath(entry.path);
				await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {});

				// 2. Delete the cloned repo dir if it lives under ~/.gitnexus/repos/.
				// getCloneDir now throws on names that are not filesystem-safe (e.g.
				// local repos registered with names like "my project" or "org/repo").
				// Such repos legitimately have no clone dir, so treat the rejection as
				// "nothing to clean up" rather than letting it fail the delete handler.
				let cloneDir: string | null = null;
				try {
					cloneDir = getCloneDir(entry.name);
				} catch {
					/* repo name not eligible for a clone dir (local repo) */
				}
				if (cloneDir) {
					try {
						const stat = await fs.stat(cloneDir);
						if (stat.isDirectory()) {
							await fs.rm(cloneDir, { recursive: true, force: true });
						}
					} catch {
						/* clone dir may not exist */
					}
				}

				// 3. Unregister from the global registry
				const { unregisterRepo } = await import("../../storage/repo-manager.js");
				await unregisterRepo(entry.path);

				// 4. Reinitialize backend to reflect the removal
				await backend.init().catch(() => {});

				res.json({ deleted: entry.name });
			} finally {
				releaseRepoLock(lockKey);
			}
		} catch (err: any) {
			res.status(500).json({ error: err.message || "Failed to delete repo" });
		}
	});

}

export const registerAnalysisRoutes = (deps: ServerRouteDeps): JobManager => {
	const { app, backend, jobManager, acquireRepoLock, releaseRepoLock, resolveRepo } = deps;

	// ── Analyze API ──────────────────────────────────────────────────────

	// POST /api/analyze — start a new analysis job
	app.post(
		"/api/analyze",
		createRouteLimiter({ limit: 10 }),
		async (req, res) => {
			try {
				const {
					url: repoUrl,
					path: repoLocalPath,
					force,
					embeddings,
					dropEmbeddings,
				} = req.body;

				// Input type validation
				if (repoUrl !== undefined && typeof repoUrl !== "string") {
					res.status(400).json({ error: '"url" must be a string' });
					return;
				}
				if (repoLocalPath !== undefined && typeof repoLocalPath !== "string") {
					res.status(400).json({ error: '"path" must be a string' });
					return;
				}

				if (!repoUrl && !repoLocalPath) {
					res
						.status(400)
						.json({ error: 'Provide "url" (git URL) or "path" (local path)' });
					return;
				}

				// Path validation: require absolute path, reject traversal (e.g. /tmp/../etc/passwd)
				if (repoLocalPath) {
					if (!path.isAbsolute(repoLocalPath)) {
						res.status(400).json({ error: '"path" must be an absolute path' });
						return;
					}
					if (path.normalize(repoLocalPath) !== path.resolve(repoLocalPath)) {
						res
							.status(400)
							.json({ error: '"path" must not contain traversal sequences' });
						return;
					}
				}

				const job = jobManager.createJob({ repoUrl, repoPath: repoLocalPath });

				// If job was already running (dedup), just return its id
				if (job.status !== "queued") {
					res.status(202).json({ jobId: job.id, status: job.status });
					return;
				}

				// Mark as active synchronously to prevent race with concurrent requests
				jobManager.updateJob(job.id, { status: "cloning" });

				// Start async work — don't await
				(async () => {
					let targetPath = repoLocalPath;
					try {
						// Clone if URL provided
						if (repoUrl && !repoLocalPath) {
							const repoName = extractRepoName(repoUrl);
							targetPath = getCloneDir(repoName);

							jobManager.updateJob(job.id, {
								status: "cloning",
								repoName,
								progress: {
									phase: "cloning",
									percent: 0,
									message: `Cloning ${repoUrl}...`,
								},
							});

							await cloneOrPull(repoUrl, targetPath, (progress) => {
								jobManager.updateJob(job.id, {
									progress: {
										phase: progress.phase,
										percent: 5,
										message: progress.message,
									},
								});
							});
						}

						if (!targetPath) {
							throw new Error("No target path resolved");
						}

						// Acquire shared repo lock (keyed on storagePath to match embed handler)
						const analyzeLockKey = getStoragePath(targetPath);
						const lockErr = acquireRepoLock(analyzeLockKey);
						if (lockErr) {
							jobManager.updateJob(job.id, { status: "failed", error: lockErr });
							return;
						}

						jobManager.updateJob(job.id, {
							repoPath: targetPath,
							status: "analyzing",
						});

						// ── Worker fork with auto-retry ──────────────────────────────
						//
						// Forks a child process with 8GB heap. If the worker crashes
						// (OOM, native addon segfault, etc.), it retries up to
						// MAX_WORKER_RETRIES times with exponential backoff before
						// marking the job as permanently failed.
						//
						// In dev mode (tsx), registers the tsx ESM hook via a file://
						// URL so the child can compile TypeScript on-the-fly.

						const MAX_WORKER_RETRIES = 2;
						const callerPath = fileURLToPath(import.meta.url);
						const isDev = callerPath.endsWith(".ts");
						const workerFile = isDev ? "analyze-worker.ts" : "analyze-worker.js";
						const workerPath = path.join(
							path.dirname(callerPath),
							"..",
							workerFile,
						);
						const tsxHookArgs: string[] = isDev
							? ["--import", pathToFileURL(_require.resolve("tsx/esm")).href]
							: [];

						const forkWorker = () => {
							const currentJob = jobManager.getJob(job.id);
							if (
								!currentJob ||
								currentJob.status === "complete" ||
								currentJob.status === "failed"
							)
								return;

							const child = fork(workerPath, [], {
								execArgv: [...tsxHookArgs, "--max-old-space-size=8192"],
								stdio: ["ignore", "pipe", "pipe", "ipc"],
							});

							// Capture stderr for crash diagnostics
							let stderrChunks = "";
							child.stderr?.on("data", (chunk: Buffer) => {
								stderrChunks += chunk.toString();
								if (stderrChunks.length > 4096)
									stderrChunks = stderrChunks.slice(-4096);
							});

							child.on("message", (msg: any) => {
								if (msg.type === "progress") {
									jobManager.updateJob(job.id, {
										status: "analyzing",
										progress: {
											phase: msg.phase,
											percent: msg.percent,
											message: msg.message,
										},
									});
								} else if (msg.type === "complete") {
									releaseRepoLock(analyzeLockKey);
									// Reinitialize backend BEFORE marking complete — ensures the new
									// repo is queryable when the client receives the SSE complete event.
									backend
										.init()
										.then(() => {
											jobManager.updateJob(job.id, {
												status: "complete",
												repoName: msg.result.repoName,
											});
										})
										.catch((err) => {
											logger.error({ err }, "backend.init() failed after analyze:");
											jobManager.updateJob(job.id, {
												status: "failed",
												error: "Server failed to reload after analysis. Try again.",
											});
										});
								} else if (msg.type === "error") {
									releaseRepoLock(analyzeLockKey);
									jobManager.updateJob(job.id, {
										status: "failed",
										error: msg.message,
									});
								}
							});

							child.on("error", (err) => {
								releaseRepoLock(analyzeLockKey);
								jobManager.updateJob(job.id, {
									status: "failed",
									error: `Worker process error: ${err.message}`,
								});
							});

							child.on("exit", (code) => {
								const j = jobManager.getJob(job.id);
								if (!j || j.status === "complete" || j.status === "failed") return;

								// Worker crashed — attempt retry if under the limit
								if (j.retryCount < MAX_WORKER_RETRIES) {
									j.retryCount++;
									const delay = 1000 * 2 ** (j.retryCount - 1); // 1s, 2s
									const lastErr = stderrChunks.trim().split("\n").pop() || "";
									logger.warn(
										`Analyze worker crashed (code ${code}), retry ${j.retryCount}/${MAX_WORKER_RETRIES} in ${delay}ms` +
											(lastErr ? `: ${lastErr}` : ""),
									);
									jobManager.updateJob(job.id, {
										status: "analyzing",
										progress: {
											phase: "retrying",
											percent: j.progress.percent,
											message: `Worker crashed, retrying (${j.retryCount}/${MAX_WORKER_RETRIES})...`,
										},
									});
									stderrChunks = "";
									setTimeout(forkWorker, delay);
								} else {
									// Exhausted retries — permanent failure
									releaseRepoLock(analyzeLockKey);
									jobManager.updateJob(job.id, {
										status: "failed",
										error: `Worker crashed ${MAX_WORKER_RETRIES + 1} times (code ${code})${stderrChunks ? `: ${stderrChunks.trim().split("\n").pop()}` : ""}`,
									});
								}
							});

							// Register child for cancellation + timeout tracking
							jobManager.registerChild(job.id, child);

							// Send start command to child
							child.send({
								type: "start",
								repoPath: targetPath,
								options: {
									force: !!force,
									embeddings: !!embeddings,
									dropEmbeddings: !!dropEmbeddings,
								},
							});
						};

						forkWorker();
					} catch (err: any) {
						if (targetPath) releaseRepoLock(getStoragePath(targetPath));
						jobManager.updateJob(job.id, {
							status: "failed",
							error: err.message || "Analysis failed",
						});
					}
				})();

				res.status(202).json({ jobId: job.id, status: job.status });
			} catch (err: any) {
				if (err.message?.includes("already in progress")) {
					res.status(409).json({ error: err.message });
				} else {
					res.status(500).json({ error: err.message || "Failed to start analysis" });
				}
			}
		},
	);

	// GET /api/analyze/:jobId — poll job status
	app.get("/api/analyze/:jobId", (req, res) => {
		const job = jobManager.getJob(req.params.jobId);
		if (!job) {
			res.status(404).json({ error: "Job not found" });
			return;
		}
		res.json({
			id: job.id,
			status: job.status,
			repoUrl: job.repoUrl,
			repoPath: job.repoPath,
			repoName: job.repoName,
			progress: job.progress,
			error: job.error,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
		});
	});

	// GET /api/analyze/:jobId/progress — SSE stream (shared helper)
	mountSSEProgress(app, "/api/analyze/:jobId/progress", jobManager);

	// DELETE /api/analyze/:jobId — cancel a running analysis job
	app.delete("/api/analyze/:jobId", (req, res) => {
		const job = jobManager.getJob(req.params.jobId);
		if (!job) {
			res.status(404).json({ error: "Job not found" });
			return;
		}
		if (job.status === "complete" || job.status === "failed") {
			res.status(400).json({ error: `Job already ${job.status}` });
			return;
		}
		jobManager.cancelJob(req.params.jobId, "Cancelled by user");
		res.json({ id: job.id, status: "failed", error: "Cancelled by user" });
	});

	// ── Embedding endpoints ────────────────────────────────────────────

	const embedJobManager = new JobManager();

	// POST /api/embed — trigger server-side embedding generation
	app.post("/api/embed", createRouteLimiter({ limit: 20 }), async (req, res) => {
		try {
			const entry = await resolveRepo(requestedRepo(req));
			if (!entry) {
				res.status(404).json({ error: "Repository not found" });
				return;
			}

			// Check shared repo lock — prevent concurrent analyze + embed on same repo
			const repoLockPath = entry.storagePath;
			const lockErr = acquireRepoLock(repoLockPath);
			if (lockErr) {
				res.status(409).json({ error: lockErr });
				return;
			}

			const job = embedJobManager.createJob({ repoPath: entry.storagePath });
			embedJobManager.updateJob(job.id, {
				repoName: entry.name,
				status: "analyzing" as any,
				progress: {
					phase: "analyzing",
					percent: 0,
					message: "Starting embedding generation...",
				},
			});

			// 30-minute timeout for embedding jobs (same as analyze jobs)
			const EMBED_TIMEOUT_MS = 30 * 60 * 1000;
			const embedTimeout = setTimeout(() => {
				const current = embedJobManager.getJob(job.id);
				if (
					current &&
					current.status !== "complete" &&
					current.status !== "failed"
				) {
					releaseRepoLock(repoLockPath);
					embedJobManager.updateJob(job.id, {
						status: "failed",
						error: "Embedding timed out (30 minute limit)",
					});
				}
			}, EMBED_TIMEOUT_MS);

			// Run embedding pipeline asynchronously
			(async () => {
				try {
					const lbugPath = path.join(entry.storagePath, "lbug");
					await withLbugDb(lbugPath, async () => {
						const { runEmbeddingPipeline } = await import(
							"../../core/embeddings/embedding-pipeline.js"
						);
						// Fetch existing content hashes for incremental embedding.
						// Delegated to lbug-adapter which owns the DB query logic and legacy-fallback handling.
						const { fetchExistingEmbeddingHashes } = await import(
							"../../core/lbug/lbug-adapter.js"
						);
						const existingEmbeddings =
							await fetchExistingEmbeddingHashes(executeQuery);
						if (existingEmbeddings && existingEmbeddings.size > 0) {
							console.log(
								`[embed] ${existingEmbeddings.size} nodes already embedded — incremental run with content-hash comparison`,
							);
						}
						await runEmbeddingPipeline(
							executeQuery,
							executeWithReusedStatement,
							(p) => {
								embedJobManager.updateJob(job.id, {
									progress: {
										phase:
											p.phase === "ready"
												? "complete"
												: p.phase === "error"
													? "failed"
													: p.phase,
										percent: p.percent,
										message:
											p.phase === "loading-model"
												? "Loading embedding model..."
												: p.phase === "embedding"
													? `Embedding nodes (${p.percent}%)...`
													: p.phase === "indexing"
														? "Creating vector index..."
														: p.phase === "ready"
															? "Embeddings complete"
															: `${p.phase} (${p.percent}%)`,
									},
								});
							},
							{}, // config: use defaults
							undefined, // skipNodeIds
							undefined, // context
							existingEmbeddings,
						);

						// Flush WAL so subsequent /api/search requests see the new
						// embeddings immediately (#1149). In the CLI path closeLbug()
						// handles this during process exit, but the server keeps the
						// connection open for other routes — a CHECKPOINT is enough.
						await flushWAL();
					});

					clearTimeout(embedTimeout);
					releaseRepoLock(repoLockPath);
					// Don't overwrite 'failed' if the job was cancelled while the pipeline was running
					const current = embedJobManager.getJob(job.id);
					if (current?.status !== "failed") {
						embedJobManager.updateJob(job.id, { status: "complete" });
					}
				} catch (err: any) {
					clearTimeout(embedTimeout);
					releaseRepoLock(repoLockPath);
					const current = embedJobManager.getJob(job.id);
					if (current?.status !== "failed") {
						embedJobManager.updateJob(job.id, {
							status: "failed",
							error: err.message || "Embedding generation failed",
						});
					}
				}
			})();

			res.status(202).json({ jobId: job.id, status: "analyzing" });
		} catch (err: any) {
			if (err.message?.includes("already in progress")) {
				res.status(409).json({ error: err.message });
			} else {
				res
					.status(500)
					.json({ error: err.message || "Failed to start embedding generation" });
			}
		}
	});

	// GET /api/embed/:jobId — poll embedding job status
	app.get("/api/embed/:jobId", (req, res) => {
		const job = embedJobManager.getJob(req.params.jobId);
		if (!job) {
			res.status(404).json({ error: "Job not found" });
			return;
		}
		res.json({
			id: job.id,
			status: job.status,
			repoName: job.repoName,
			progress: job.progress,
			error: job.error,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
		});
	});

	// GET /api/embed/:jobId/progress — SSE stream (shared helper)
	mountSSEProgress(app, "/api/embed/:jobId/progress", embedJobManager);

	// DELETE /api/embed/:jobId — cancel embedding job
	app.delete("/api/embed/:jobId", (req, res) => {
		const job = embedJobManager.getJob(req.params.jobId);
		if (!job) {
			res.status(404).json({ error: "Job not found" });
			return;
		}
		if (job.status === "complete" || job.status === "failed") {
			res.status(400).json({ error: `Job already ${job.status}` });
			return;
		}
		embedJobManager.cancelJob(req.params.jobId, "Cancelled by user");
		res.json({ id: job.id, status: "failed", error: "Cancelled by user" });
	});

	return embedJobManager;
};
