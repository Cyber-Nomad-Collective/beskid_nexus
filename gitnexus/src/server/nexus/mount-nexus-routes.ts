import { createHmac, timingSafeEqual } from "node:crypto";
import express, {
	type Express,
	type NextFunction,
	type Request,
	type Response,
} from "express";
import { logger } from "../../core/logger.js";
import type { LocalBackend } from "../../mcp/local/local-backend.js";
import type { JobManager } from "../analyze-job.js";
import { extractRepoName, getCloneDir } from "../git-clone.js";
import { createRouteLimiter } from "../validation.js";
import { type AnalyzeRunnerDeps, startAnalyzeJob } from "./analyze-runner.js";
import {
	createCatalogEntry,
	deleteCatalogEntry,
	findCatalogByGitUrl,
	getCatalogEntry,
	listCatalogEntries,
	listPublicCatalog,
	slugifyCatalogId,
	updateCatalogEntry,
} from "./catalog-store.js";
import { startCodeDocJob } from "./code-doc-runner.js";
import { getAuthentikIdentity, isAuthentikAdmin } from "./authentik-identity.js";
import {
	FREE_DOC_MODEL,
	getOpenRouterSettingsPublic,
	updateOpenRouterSettings,
} from "./openrouter-settings.js";
import { getRemoteHead } from "./remote-git.js";

export interface MountNexusRoutesDeps extends AnalyzeRunnerDeps {
	backend: LocalBackend;
	jobManager: JobManager;
	acquireRepoLock: (repoPath: string) => string | null;
	releaseRepoLock: (repoPath: string) => void;
}

const requireAdmin = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const identity = getAuthentikIdentity(req);
		if (!identity) {
			res.status(401).json({ error: "Not authenticated" });
			return;
		}
		if (!isAuthentikAdmin(identity)) {
			res.status(403).json({ error: "Admin access required" });
			return;
		}
		(req as any).nexusIdentity = identity;
		next();
	} catch (err: any) {
		res.status(500).json({ error: err.message || "Auth check failed" });
	}
};


export const mountNexusRoutes = (
	app: Express,
	deps: MountNexusRoutesDeps,
): void => {
	const runnerDeps: AnalyzeRunnerDeps = {
		jobManager: deps.jobManager,
		backend: deps.backend,
		acquireRepoLock: deps.acquireRepoLock,
		releaseRepoLock: deps.releaseRepoLock,
	};

	// ── Authentik proxy identity ──────────────────────────────────────────

	app.get("/api/auth/me", (req, res) => {
		const identity = getAuthentikIdentity(req);
		if (!identity) {
			res.status(401).json({
				error: "Authentik proxy identity is required. Route Nexus through Caddy forward_auth.",
			});
			return;
		}
		res.json({
			login: identity.username,
			name: identity.name,
			avatarUrl: "",
			isAdmin: isAuthentikAdmin(identity),
			ownedRepoIds: [],
		});
	});

	// ── Public catalog ────────────────────────────────────────────────────

	app.get("/api/catalog", async (_req, res) => {
		try {
			const entries = await listPublicCatalog();
			res.json(entries);
		} catch (err: any) {
			res.status(500).json({ error: err.message || "Failed to list catalog" });
		}
	});

	app.get("/api/catalog/:id", async (req, res) => {
		try {
			const entry = await getCatalogEntry(req.params.id);
			if (!entry?.enabled) {
				res.status(404).json({ error: "Not found" });
				return;
			}
			const [publicEntry] = (await listPublicCatalog()).filter(
				(e) => e.id === entry.id,
			);
			res.json(publicEntry ?? entry);
		} catch (err: any) {
			res
				.status(500)
				.json({ error: err.message || "Failed to get catalog entry" });
		}
	});

	// ── Admin catalog ─────────────────────────────────────────────────────

	app.get("/api/admin/catalog", requireAdmin, async (_req, res) => {
		try {
			res.json(await listCatalogEntries());
		} catch (err: any) {
			res.status(500).json({ error: err.message || "Failed to list catalog" });
		}
	});

	app.post(
		"/api/admin/catalog",
		requireAdmin,
		createRouteLimiter({ limit: 30 }),
		async (req, res) => {
			try {
				const {
					displayName,
					description,
					gitUrl,
					defaultBranch,
					id,
					enabled,
					sortOrder,
				} = req.body ?? {};
				if (typeof displayName !== "string" || typeof gitUrl !== "string") {
					res.status(400).json({ error: "displayName and gitUrl are required" });
					return;
				}
				const entry = await createCatalogEntry({
					id: typeof id === "string" ? slugifyCatalogId(id) : undefined,
					displayName,
					description: typeof description === "string" ? description : "",
					gitUrl,
					defaultBranch:
						typeof defaultBranch === "string" ? defaultBranch : undefined,
					enabled: typeof enabled === "boolean" ? enabled : true,
					sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
				});
				res.status(201).json(entry);
			} catch (err: any) {
				res
					.status(400)
					.json({ error: err.message || "Failed to create catalog entry" });
			}
		},
	);

	app.patch(
		"/api/admin/catalog/:id",
		requireAdmin,
		async (req, res) => {
			try {
				const entry = await updateCatalogEntry(req.params.id, req.body ?? {});
				res.json(entry);
			} catch (err: any) {
				res
					.status(400)
					.json({ error: err.message || "Failed to update catalog entry" });
			}
		},
	);

	app.delete(
		"/api/admin/catalog/:id",
		requireAdmin,
		async (req, res) => {
			try {
				await deleteCatalogEntry(req.params.id);
				res.json({ ok: true });
			} catch (err: any) {
				res
					.status(400)
					.json({ error: err.message || "Failed to delete catalog entry" });
			}
		},
	);

	app.post(
		"/api/admin/catalog/:id/analyze",
		requireAdmin,
		createRouteLimiter({ limit: 10 }),
		async (req, res) => {
			try {
				const entry = await getCatalogEntry(req.params.id);
				if (!entry) {
					res.status(404).json({ error: "Catalog entry not found" });
					return;
				}

				const remoteHead = await getRemoteHead(entry.gitUrl, entry.defaultBranch);
				const result = await startAnalyzeJob(runnerDeps, {
					repoUrl: entry.gitUrl,
					registryName: entry.id,
					catalogEntryId: entry.id,
					skipIfCommit: entry.lastIndexedCommit,
					defaultBranch: entry.defaultBranch,
					force: !!req.body?.force,
					embeddings: !!req.body?.embeddings,
				});

				if (result.skipped) {
					res.json({ skipped: true, reason: result.reason, remoteHead });
					return;
				}

				res
					.status(202)
					.json({ jobId: result.jobId, status: result.status, remoteHead });
			} catch (err: any) {
				if (err.message?.includes("already in progress")) {
					res.status(409).json({ error: err.message });
					return;
				}
				res.status(500).json({ error: err.message || "Failed to start analysis" });
			}
		},
	);

	app.post(
		"/api/admin/catalog/:id/refresh-docs",
		requireAdmin,
		createRouteLimiter({ limit: 10 }),
		async (req, res) => {
			try {
				const entry = await getCatalogEntry(req.params.id);
				if (!entry) {
					res.status(404).json({ error: "Catalog entry not found" });
					return;
				}

				const registryName = entry.registryName ?? entry.id;
				const repoPath = getCloneDir(extractRepoName(entry.gitUrl));
				const result = await startCodeDocJob({
					registryName,
					repoPath,
					catalogEntryId: entry.id,
					maxEntities:
						typeof req.body?.maxEntities === "number"
							? req.body.maxEntities
							: undefined,
				});

				if (result.status === "skipped") {
					res.json({ skipped: true, reason: result.reason, jobId: result.jobId });
					return;
				}

				res.status(202).json({ jobId: result.jobId, status: result.status });
			} catch (err: any) {
				res
					.status(500)
					.json({ error: err.message || "Failed to start doc refresh" });
			}
		},
	);

	// ── Admin settings ────────────────────────────────────────────────────

	app.get("/api/admin/settings/openrouter", requireAdmin, async (_req, res) => {
		try {
			res.json(await getOpenRouterSettingsPublic());
		} catch (err: any) {
			res
				.status(500)
				.json({ error: err.message || "Failed to load OpenRouter settings" });
		}
	});

	app.patch("/api/admin/settings/openrouter", requireAdmin, async (req, res) => {
		try {
			const { apiKey, model } = req.body ?? {};
			if (
				typeof model === "string" &&
				model.trim() &&
				model.trim() !== FREE_DOC_MODEL
			) {
				res.status(400).json({ error: `Only ${FREE_DOC_MODEL} is supported` });
				return;
			}
			const result = await updateOpenRouterSettings({
				apiKey: typeof apiKey === "string" ? apiKey : undefined,
			});
			res.json(result);
		} catch (err: any) {
			res
				.status(400)
				.json({ error: err.message || "Failed to update OpenRouter settings" });
		}
	});
};

/** Register before `express.json()` so the raw body is available for HMAC verification. */
export const mountGithubWebhook = (
	app: Express,
	deps: MountNexusRoutesDeps,
): void => {
	const runnerDeps: AnalyzeRunnerDeps = {
		jobManager: deps.jobManager,
		backend: deps.backend,
		acquireRepoLock: deps.acquireRepoLock,
		releaseRepoLock: deps.releaseRepoLock,
	};

	app.post(
		"/api/webhooks/github",
		express.raw({ type: "application/json" }),
		async (req, res) => {
			const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
			const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

			if (secret) {
				const sig = req.headers["x-hub-signature-256"];
				if (
					typeof sig !== "string" ||
					!verifyGithubSignature(secret, sig, rawBody)
				) {
					res.status(401).json({ error: "Invalid signature" });
					return;
				}
			}

			const event = req.headers["x-github-event"];
			if (event !== "push") {
				res.status(200).json({ ok: true, ignored: true });
				return;
			}

			let payload: any;
			try {
				payload = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
			} catch {
				res.status(400).json({ error: "Invalid JSON" });
				return;
			}

			const repoUrl =
				payload?.repository?.html_url || payload?.repository?.clone_url || "";
			const after = typeof payload?.after === "string" ? payload.after : "";

			if (!repoUrl || !after) {
				res.status(400).json({ error: "Invalid push payload" });
				return;
			}

			const entry = await findCatalogByGitUrl(repoUrl);
			if (!entry?.enabled) {
				res.status(200).json({ ok: true, ignored: true });
				return;
			}

			if (entry.lastIndexedCommit === after) {
				res.status(200).json({ ok: true, skipped: true });
				return;
			}

			try {
				const result = await startAnalyzeJob(runnerDeps, {
					repoUrl: entry.gitUrl,
					registryName: entry.id,
					catalogEntryId: entry.id,
					defaultBranch: entry.defaultBranch,
					force: false,
				});
				res
					.status(202)
					.json({ ok: true, jobId: result.jobId, status: result.status });
			} catch (err: any) {
				if (err.message?.includes("already in progress")) {
					res.status(202).json({ ok: true, queued: false, reason: err.message });
					return;
				}
				logger.error({ err }, "Webhook analyze failed");
				res.status(500).json({ error: err.message || "Analyze failed" });
			}
		},
	);
};

function verifyGithubSignature(
	secret: string,
	header: string,
	rawBody?: Buffer,
): boolean {
	if (!rawBody) return false;
	const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
	try {
		return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
	} catch {
		return false;
	}
}
