import fs from "node:fs/promises";
import path from "node:path";

import {
	executeQuery,
	withLbugDb,
} from "../../core/lbug/lbug-adapter.js";
import {
	assertString,
	createRouteLimiter,
	escapeRegExp,
} from "../validation.js";
import type { ServerRouteDeps } from "./contracts.js";
import {
	handleFileRequest,
	requestedRepo,
	statusFromError,
} from "./middleware-errors.js";

export const registerProcessDiffRoutes = (
	deps: Pick<ServerRouteDeps, "app" | "backend" | "resolveRepo">,
): void => {
	const { app, backend, resolveRepo } = deps;

	// Read file — with path traversal guard
	// Rate-limited (CodeQL js/missing-rate-limiting): per-request fs.readFile.
	app.get("/api/file", createRouteLimiter(), async (req, res) => {
		const entry = await resolveRepo(requestedRepo(req));
		if (!entry) {
			res.status(404).json({ error: "Repository not found" });
			return;
		}
		await handleFileRequest(req, res, entry.path);
	});

	// Grep — regex search across file contents in the indexed repo
	// Uses filesystem-based search for memory efficiency (never loads all files into memory)
	// Rate-limited (CodeQL js/missing-rate-limiting): scans every file in
	// the indexed repo per request — heaviest I/O endpoint. Same default 60
	// rpm/IP for now; consider tightening if real-world load shows abuse.
	app.get("/api/grep", createRouteLimiter(), async (req, res) => {
		try {
			const entry = await resolveRepo(requestedRepo(req));
			if (!entry) {
				res.status(404).json({ error: "Repository not found" });
				return;
			}
			// Type-confusion guard (CodeQL js/type-confusion-through-parameter-tampering):
			// req.query.pattern is `string | string[] | ParsedQs` — without an explicit
			// type check, the `.length` guard below counts array elements instead of
			// characters, allowing arbitrarily long patterns through.
			const rawPattern = req.query.pattern;
			if (rawPattern === undefined) {
				res.status(400).json({ error: 'Missing "pattern" query parameter' });
				return;
			}
			const pattern = assertString(rawPattern, "pattern");
			if (pattern.length === 0) {
				res.status(400).json({ error: 'Missing "pattern" query parameter' });
				return;
			}

			// Length cap: applies to both literal and regex modes as a defense-in-depth
			// bound against pathological input.
			if (pattern.length > 200) {
				res.status(400).json({ error: "Pattern too long (max 200 characters)" });
				return;
			}

			// Treat user input as a literal substring in all cases to prevent
			// regex-injection/ReDoS via attacker-controlled regex syntax.
			const effectivePattern = escapeRegExp(pattern);

			// Validate regex syntax (catches both opt-in user regex and any escapeRegExp bug)
			let regex: RegExp;
			try {
				regex = new RegExp(effectivePattern, "gim");
			} catch {
				res.status(400).json({ error: "Invalid regex pattern" });
				return;
			}

			const parsedLimit = Number(req.query.limit ?? 50);
			const limit = Number.isFinite(parsedLimit)
				? Math.max(1, Math.min(200, Math.trunc(parsedLimit)))
				: 50;

			const results: { filePath: string; line: number; text: string }[] = [];
			const repoRoot = path.resolve(entry.path);

			// Get file paths from the graph (lightweight — no content loaded)
			const lbugPath = path.join(entry.storagePath, "lbug");
			const fileRows = await withLbugDb(lbugPath, () =>
				executeQuery(
					`MATCH (n:File) WHERE n.content IS NOT NULL RETURN n.filePath AS filePath`,
				),
			);

			// Search files on disk one at a time (constant memory)
			for (const row of fileRows) {
				if (results.length >= limit) break;
				const filePath: string = row.filePath || "";
				const fullPath = path.resolve(repoRoot, filePath);

				// Path traversal guard
				if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot)
					continue;

				let content: string;
				try {
					content = await fs.readFile(fullPath, "utf-8");
				} catch {
					continue; // File may have been deleted since indexing
				}

				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (results.length >= limit) break;
					if (regex.test(lines[i])) {
						results.push({
							filePath,
							line: i + 1,
							text: lines[i].trim().slice(0, 200),
						});
					}
					regex.lastIndex = 0;
				}
			}

			res.json({ results });
		} catch (err: any) {
			res
				.status(statusFromError(err))
				.json({ error: err.message || "Grep failed" });
		}
	});

	// List all processes
	app.get("/api/processes", async (req, res) => {
		try {
			const result = await backend.queryProcesses(requestedRepo(req));
			res.json(result);
		} catch (err: any) {
			res
				.status(statusFromError(err))
				.json({ error: err.message || "Failed to query processes" });
		}
	});

	// Process detail
	app.get("/api/process", async (req, res) => {
		try {
			const name = String(req.query.name ?? "").trim();
			if (!name) {
				res.status(400).json({ error: 'Missing "name" query parameter' });
				return;
			}

			const result = await backend.queryProcessDetail(name, requestedRepo(req));
			if (result?.error) {
				res.status(404).json({ error: result.error });
				return;
			}
			res.json(result);
		} catch (err: any) {
			res
				.status(statusFromError(err))
				.json({ error: err.message || "Failed to query process detail" });
		}
	});

	// List all clusters
	app.get("/api/clusters", async (req, res) => {
		try {
			const result = await backend.queryClusters(requestedRepo(req));
			res.json(result);
		} catch (err: any) {
			res
				.status(statusFromError(err))
				.json({ error: err.message || "Failed to query clusters" });
		}
	});

	// Cluster detail
	app.get("/api/cluster", async (req, res) => {
		try {
			const name = String(req.query.name ?? "").trim();
			if (!name) {
				res.status(400).json({ error: 'Missing "name" query parameter' });
				return;
			}

			const result = await backend.queryClusterDetail(name, requestedRepo(req));
			if (result?.error) {
				res.status(404).json({ error: result.error });
				return;
			}
			res.json(result);
		} catch (err: any) {
			res
				.status(statusFromError(err))
				.json({ error: err.message || "Failed to query cluster detail" });
		}
	});

}

