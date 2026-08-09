import {
	type CodebaseContext,
	type RepoHandle,
} from "./formatting-errors.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
	closeLbug,
	initLbug,
	isLbugReady,
} from "../../../core/lbug/pool-adapter.js";
import { checkCwdMatch, checkStalenessAsync } from "../../../core/git-staleness.js";
import { logger } from "../../../core/logger.js";
import {
	cleanupOldKuzuFiles,
	listRegisteredRepos,
} from "../../../storage/repo-manager.js";

export class LifecycleBackend {
	protected repos: Map<string, RepoHandle> = new Map();
	protected contextCache: Map<string, CodebaseContext> = new Map();
	protected initializedRepos: Set<string> = new Set();
	protected reinitPromises: Map<string, Promise<void>> = new Map();
	protected lastStalenessCheck: Map<string, number> = new Map();
	/**
	 * One-shot stderr warnings for sibling-clone drift, keyed by
	 * `${repoId}|${cwdGitRoot}`. Without this guard every tool call
	 * from inside a sibling clone would print the same warning,
	 * making MCP stderr unreadable.
	 */
	protected warnedSiblingDrift: Set<string> = new Set();

	/**
	 * One-shot stderr warning for the VECTOR-extension fallback. Without this
	 * guard the diagnostic would fire on every `semanticSearch()` call on
	 * platforms where the extension is unsupported (e.g. Windows), making MCP
	 * stderr noisy per DoD §2.8.
	 */
	protected warnedVectorUnsupported = false;

	/**
	 * Cross-repo group tools (CLI). Shares logic with MCP `group_*` handlers.
	 */
	async dispose(): Promise<void> {
		await closeLbug();
	}

	// ─── Initialization ──────────────────────────────────────────────

	/**
	 * Initialize from the global registry.
	 * Returns true if at least one repo is available.
	 */
	async init(): Promise<boolean> {
		await this.refreshRepos();
		return this.repos.size > 0;
	}

	/**
	 * Re-read the global registry and update the in-memory repo map.
	 * New repos are added, existing repos are updated, removed repos are pruned.
	 * LadybugDB connections for removed repos are NOT closed (they idle-timeout naturally).
	 */
	protected async refreshRepos(): Promise<void> {
		const entries = await listRegisteredRepos({ validate: true });
		const freshIds = new Set<string>();

		for (const entry of entries) {
			const id = this.repoId(entry.name, entry.path);
			freshIds.add(id);

			const storagePath = entry.storagePath;
			const lbugPath = path.join(storagePath, "lbug");

			// Clean up any leftover KuzuDB files from before the LadybugDB migration.
			// If kuzu exists but lbug doesn't, warn so the user knows to re-analyze.
			const kuzu = await cleanupOldKuzuFiles(storagePath);
			if (kuzu.found && kuzu.needsReindex) {
				logger.error(
					`GitNexus: "${entry.name}" has a stale KuzuDB index. Run: gitnexus analyze ${entry.path}`,
				);
			}

			const handle: RepoHandle = {
				id,
				name: entry.name,
				repoPath: entry.path,
				storagePath,
				lbugPath,
				indexedAt: entry.indexedAt,
				lastCommit: entry.lastCommit,
				remoteUrl: entry.remoteUrl,
				stats: entry.stats,
			};

			this.repos.set(id, handle);

			// Build lightweight context (no LadybugDB needed)
			const s = entry.stats || {};
			this.contextCache.set(id, {
				projectName: entry.name,
				stats: {
					fileCount: s.files || 0,
					functionCount: s.nodes || 0,
					communityCount: s.communities || 0,
					processCount: s.processes || 0,
				},
			});
		}

		// Prune repos that no longer exist in the registry
		for (const id of this.repos.keys()) {
			if (!freshIds.has(id)) {
				this.repos.delete(id);
				this.contextCache.delete(id);
				this.initializedRepos.delete(id);
			}
		}
	}

	/**
	 * Generate a stable repo ID from name + path.
	 * If names collide, append a hash of the path.
	 */
	protected repoId(name: string, repoPath: string): string {
		const base = name.toLowerCase();
		// Check for name collision with a different path
		for (const [id, handle] of this.repos) {
			if (id === base && handle.repoPath !== path.resolve(repoPath)) {
				// Collision — use path hash
				const hash = Buffer.from(repoPath).toString("base64url").slice(0, 6);
				return `${base}-${hash}`;
			}
		}
		return base;
	}

	// ─── Repo Resolution ─────────────────────────────────────────────

	/**
	 * Resolve which repo to use.
	 * - If repoParam is given, match by name or path
	 * - If only 1 repo, use it
	 * - If 0 or multiple without param, throw with helpful message
	 *
	 * On a miss, re-reads the registry once in case a new repo was indexed
	 * while the MCP server was running.
	 */
	async resolveRepo(repoParam?: string): Promise<RepoHandle> {
		const result = this.resolveRepoFromCache(repoParam);
		if (result) {
			// Issue: silent graph drift across sibling clones.
			// If the caller's cwd lives in a *different* on-disk clone of
			// the same repo (matched by `remoteUrl`), warn once per
			// (repo, cwd) pair on stderr. We do not fail or refuse to
			// serve — the index is still the best answer we have — but
			// the operator/agent has to know the answer may be stale.
			this.maybeWarnSiblingDrift(result).catch(() => {
				/* best-effort; never throw from resolveRepo */
			});
			return result;
		}

		// Miss — refresh registry and try once more
		await this.refreshRepos();
		const retried = this.resolveRepoFromCache(repoParam);
		if (retried) {
			this.maybeWarnSiblingDrift(retried).catch(() => {});
			return retried;
		}

		// Still no match — throw with helpful message
		if (this.repos.size === 0) {
			throw new Error("No indexed repositories. Run: gitnexus analyze");
		}

		// Build a disambiguated "Available: …" list (#829). When two handles
		// share a name, annotate each colliding label with its path so the
		// caller can actually pick the right one. Single-name entries render
		// identically to pre-#829 output.
		const nameCounts = new Map<string, number>();
		for (const h of this.repos.values()) {
			const key = h.name.toLowerCase();
			nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
		}
		const labels = [...this.repos.values()].map((h) =>
			(nameCounts.get(h.name.toLowerCase()) ?? 0) > 1
				? `${h.name} (${h.repoPath})`
				: h.name,
		);

		if (repoParam) {
			throw new Error(
				`Repository "${repoParam}" not found. Available: ${labels.join(", ")}`,
			);
		}
		throw new Error(
			`Multiple repositories indexed. Specify which one with the "repo" parameter. Available: ${labels.join(", ")}`,
		);
	}

	/**
	 * Try to resolve a repo from the in-memory cache. Returns null on miss.
	 */
	protected resolveRepoFromCache(repoParam?: string): RepoHandle | null {
		if (this.repos.size === 0) return null;

		if (repoParam) {
			const paramLower = repoParam.toLowerCase();
			// Match by id
			if (this.repos.has(paramLower)) return this.repos.get(paramLower)!;
			// Match by name (case-insensitive)
			for (const handle of this.repos.values()) {
				if (handle.name.toLowerCase() === paramLower) return handle;
			}
			// Match by path (substring)
			const resolved = path.resolve(repoParam);
			for (const handle of this.repos.values()) {
				if (handle.repoPath === resolved) return handle;
			}
			// Match by partial name
			for (const handle of this.repos.values()) {
				if (handle.name.toLowerCase().includes(paramLower)) return handle;
			}
			return null;
		}

		if (this.repos.size === 1) {
			return this.repos.values().next().value!;
		}

		return null; // Multiple repos, no param — ambiguous
	}

	// ─── Lazy LadybugDB Init ────────────────────────────────────────────

	protected async ensureInitialized(repoId: string): Promise<void> {
		// If a reinit is already in progress for this repo, wait for it
		const pending = this.reinitPromises.get(repoId);
		if (pending) return pending;

		const handle = this.repos.get(repoId);
		if (!handle) throw new Error(`Unknown repo: ${repoId}`);

		// Check if the index was rebuilt since we opened the connection (#297).
		// Throttle staleness checks to at most once per 5 seconds per repo to
		// avoid an fs.readFile round-trip on every tool invocation.
		if (this.initializedRepos.has(repoId) && isLbugReady(repoId)) {
			const now = Date.now();
			const lastCheck = this.lastStalenessCheck.get(repoId) ?? 0;
			if (now - lastCheck < 5000) return; // Checked recently — skip

			this.lastStalenessCheck.set(repoId, now);
			try {
				const metaPath = path.join(handle.storagePath, "meta.json");
				const metaRaw = await fs.readFile(metaPath, "utf-8");
				const meta = JSON.parse(metaRaw);
				if (meta.indexedAt && meta.indexedAt !== handle.indexedAt) {
					// Index was rebuilt — close stale connection and re-init.
					// Wrap in reinitPromises to prevent TOCTOU race where concurrent
					// callers both detect staleness and double-close the pool.
					const reinit = (async () => {
						try {
							await closeLbug(repoId);
							this.initializedRepos.delete(repoId);
							handle.indexedAt = meta.indexedAt;
							await initLbug(repoId, handle.lbugPath);
							this.initializedRepos.add(repoId);
						} finally {
							this.reinitPromises.delete(repoId);
						}
					})();
					this.reinitPromises.set(repoId, reinit);
					return reinit;
				} else {
					return; // Pool is current
				}
			} catch {
				return; // Can't read meta — assume pool is fine
			}
		}

		try {
			await initLbug(repoId, handle.lbugPath);
			this.initializedRepos.add(repoId);
		} catch (err: any) {
			// If lock error, mark as not initialized so next call retries
			this.initializedRepos.delete(repoId);
			throw err;
		}
	}

	// ─── Public Getters ──────────────────────────────────────────────

	/**
	 * Get context for a specific repo (or the single repo if only one).
	 */
	getContext(repoId?: string): CodebaseContext | null {
		if (repoId && this.contextCache.has(repoId)) {
			return this.contextCache.get(repoId)!;
		}
		if (this.repos.size === 1) {
			return this.contextCache.values().next().value ?? null;
		}
		return null;
	}

	/**
	 * List all registered repos with their metadata.
	 * Re-reads the global registry so newly indexed repos are discovered
	 * without restarting the MCP server.
	 *
	 * Each entry includes:
	 *   - `staleness`: if the indexed clone's own HEAD has moved past
	 *     the recorded `lastCommit` (option D in the issue's fix list).
	 *   - `siblings`: other registered entries sharing the same
	 *     `remoteUrl` (option B's payoff: callers can see at a glance
	 *     that another clone of the same logical repo is registered).
	 *   - `remoteUrl`: the canonical origin URL recorded at index time.
	 */
	async listRepos(): Promise<
		Array<{
			name: string;
			path: string;
			indexedAt: string;
			lastCommit: string;
			remoteUrl?: string;
			stats?: any;
			staleness?: { commitsBehind: number; hint?: string };
			siblings?: Array<{ name: string; path: string; lastCommit: string }>;
		}>
	> {
		await this.refreshRepos();
		const handles = [...this.repos.values()];

		// Pre-group registered handles by `remoteUrl` so the sibling
		// lookup is O(1) per handle. We reuse the in-memory `this.repos`
		// (already populated by `refreshRepos`) instead of doing a fresh
		// `readRegistry()` per entry — that would be N file reads for N
		// registered repos.
		const isWin = process.platform === "win32";
		const norm = (p: string) =>
			isWin ? path.resolve(p).toLowerCase() : path.resolve(p);
		const byRemote = new Map<string, RepoHandle[]>();
		for (const h of handles) {
			if (!h.remoteUrl) continue;
			const list = byRemote.get(h.remoteUrl) ?? [];
			list.push(h);
			byRemote.set(h.remoteUrl, list);
		}

		// Check staleness for all repos in parallel instead of sequentially.
		// Each check spawns an async `git rev-list` — with 200 repos the sync
		// variant took ~50 s; parallel async brings it under a second (#1363).
		const stalenessResults = await Promise.all(
			handles.map((h) => checkStalenessAsync(h.repoPath, h.lastCommit)),
		);

		return handles.map((h, i) => {
			const stale = stalenessResults[i];
			const selfNorm = norm(h.repoPath);
			const siblings = h.remoteUrl
				? (byRemote.get(h.remoteUrl) ?? []).filter(
						(e) => norm(e.repoPath) !== selfNorm,
					)
				: [];
			return {
				name: h.name,
				path: h.repoPath,
				indexedAt: h.indexedAt,
				lastCommit: h.lastCommit,
				remoteUrl: h.remoteUrl,
				stats: h.stats,
				staleness: stale.isStale
					? { commitsBehind: stale.commitsBehind, hint: stale.hint }
					: undefined,
				siblings:
					siblings.length > 0
						? siblings.map((s) => ({
								name: s.name,
								path: s.repoPath,
								lastCommit: s.lastCommit,
							}))
						: undefined,
			};
		});
	}

	/**
	 * Best-effort sibling-clone drift warning.
	 *
	 * When the resolved index has a `remoteUrl` recorded and the caller's
	 * `process.cwd()` is inside a *different* clone of the same repo, emit
	 * one stderr line per (repo, cwd) pair so the operator knows the
	 * graph may be stale relative to what's actually on disk under their
	 * cwd. Silent on path matches and on repos without a remote URL.
	 *
	 * Limitation: in MCP stdio server mode `process.cwd()` is the
	 * server's CWD at start time, *not* the agent client's CWD. The
	 * warning therefore only fires when the MCP server itself was
	 * launched from inside a sibling clone (typical for `npx gitnexus
	 * serve` from a polecat workspace). Surfacing the client's CWD
	 * would require a per-tool-call `cwd` parameter — out of scope for
	 * the current MCP contract.
	 *
	 * Pure side-effect (stderr); never affects the returned handle.
	 * After the first computation for a given (repo, cwd) pair the
	 * result is cached so subsequent `resolveRepo()` calls don't
	 * re-shell-out to git.
	 */
	protected async maybeWarnSiblingDrift(handle: RepoHandle): Promise<void> {
		if (!handle.remoteUrl) return;
		let cwd: string;
		try {
			cwd = process.cwd();
		} catch {
			return;
		}
		// Early-exit cache: keyed on (repo, cwd) BEFORE any git shellout.
		// After the first call for a given cwd, this short-circuits the
		// up-to-four `execSync`/`execFileSync` calls inside `checkCwdMatch`
		// — important for MCP-server mode where `process.cwd()` is constant
		// and `resolveRepo` runs on every tool call.
		const cacheKey = `${handle.id}|${cwd}`;
		if (this.warnedSiblingDrift.has(cacheKey)) return;

		const match = await checkCwdMatch(cwd);
		if (
			match.match !== "sibling-by-remote" ||
			!match.entry ||
			!match.cwdGitRoot ||
			match.entry.path !== handle.repoPath ||
			!match.hint
		) {
			// Cache "nothing to warn about" outcomes too — `checkCwdMatch`
			// is deterministic for a fixed (registry, cwd) pair, so re-running
			// it yields nothing new.
			this.warnedSiblingDrift.add(cacheKey);
			return;
		}

		this.warnedSiblingDrift.add(cacheKey);
		logger.error(`GitNexus: ${match.hint}`);
	}

	// ─── Tool Dispatch ───────────────────────────────────────────────

}
