export interface RepoMeta {
	repoPath: string;
	lastCommit: string;
	indexedAt: string;
	/**
	 * Canonical `origin` remote URL captured at index time. Used to
	 * fingerprint the same logical repo across multiple on-disk clones
	 * (worktrees, agent workspaces, "clean clone for indexing"). When
	 * absent (no remote configured, git unavailable, etc.) the repo is
	 * treated as path-only and sibling-clone detection is skipped.
	 */
	remoteUrl?: string;
	stats?: {
		files?: number;
		nodes?: number;
		edges?: number;
		communities?: number;
		processes?: number;
		embeddings?: number;
	};
	/**
	 * Bumped whenever incremental-indexing invariants change in an
	 * incompatible way (delete-and-rewrite logic, subgraph extraction,
	 * graph-wide node handling). On mismatch, runFullAnalysis forces a
	 * full rebuild rather than risk an inconsistent incremental update.
	 */
	schemaVersion?: number;
	/**
	 * SHA-256 of every file's content at the time of the last successful
	 * indexing run. The next run computes current hashes and diffs against
	 * this map to determine which files' DB rows must be replaced.
	 * Map keys are repo-relative paths.
	 */
	fileHashes?: Record<string, string>;
	/**
	 * Crash-recovery dirty flag. Written to meta.json BEFORE any
	 * destructive DB mutation in an incremental run; cleared on success
	 * by overwriting meta.json. If a run crashes between, the next run
	 * sees the flag and forces a full rebuild — the cheapest path back
	 * to a known-good index.
	 */
	incrementalInProgress?: {
		/** When the incremental run started (epoch ms). */
		startedAt: number;
		/** Number of files in the writable set, for diagnostic logs. */
		toWriteCount: number;
	};
}

/**
 * Bumped whenever incremental-indexing invariants change incompatibly.
 */
export const INCREMENTAL_SCHEMA_VERSION = 1;

export interface IndexedRepo {
	repoPath: string;
	storagePath: string;
	lbugPath: string;
	metaPath: string;
	meta: RepoMeta;
}

/**
 * Shape of an entry in the global registry (~/.gitnexus/registry.json)
 */
export interface RegistryEntry {
	name: string;
	path: string;
	storagePath: string;
	indexedAt: string;
	lastCommit: string;
	/** See {@link RepoMeta.remoteUrl}. Mirrored from meta at register time. */
	remoteUrl?: string;
	stats?: RepoMeta["stats"];
}

/**
 * Options for {@link registerRepo}. All optional — callers without any
 * disambiguation requirement can keep calling `registerRepo(path, meta)`
 * unchanged.
 */
export interface RegisterRepoOptions {
	/**
	 * User-provided alias from `analyze --name <alias>` (#829). Overrides
	 * the default basename-derived registry `name`. Persisted — subsequent
	 * re-analyses of the same path without `--name` preserve the alias.
	 */
	name?: string;
	/**
	 * Allow two DIFFERENT repo paths to register under the same alias
	 * (#829). Mapped from the `--allow-duplicate-name` CLI flag.
	 *
	 * Scope: this flag governs cross-path alias sharing only — one repo
	 * path always has exactly one registry entry (and therefore exactly
	 * one alias). Re-analyzing the same path with `--name Y` overwrites
	 * a previous `--name X`; it does NOT create a second entry or a
	 * second alias for the same path (see the upsert-by-resolved-path
	 * logic in {@link registerRepo} and the
	 * `re-registerRepo with a different name overrides the previous
	 * alias` test in `test/unit/repo-manager.test.ts`).
	 *
	 * Distinct from `--force` (which only triggers pipeline re-index);
	 * a user accepting a duplicate alias should not be forced to also
	 * re-run the full pipeline.
	 */
	allowDuplicateName?: boolean;
}
// ─── Global CLI Config (~/.gitnexus/config.json) ─────────────────────────

export interface CLIConfig {
	apiKey?: string;
	model?: string;
	baseUrl?: string;
	provider?: "openai" | "openrouter" | "azure" | "custom" | "cursor";
	cursorModel?: string;
	/** Azure api-version query param (e.g. '2024-10-21'). Only used when provider is 'azure'. */
	apiVersion?: string;
	/** Set true when the deployment is a reasoning model (o1, o3, o4-mini). Auto-detected for OpenAI; must be set for Azure deployments. */
	isReasoningModel?: boolean;
}
/**
 * Description of how a working directory relates to a registered index.
 *
 * `match` semantics:
 *   - `path`              — `cwd` is inside the registered entry's path.
 *   - `sibling-by-remote` — `cwd` is in a different on-disk clone of the
 *                           same repo (same `remoteUrl`).
 *   - `none`              — no relationship found.
 */
export interface CwdMatch {
	match: "path" | "sibling-by-remote" | "none";
	entry?: RegistryEntry;
	/** The git toplevel of `cwd`, when `cwd` is inside a git work tree. */
	cwdGitRoot?: string;
	/** HEAD of the cwd's clone, when resolvable. */
	cwdHead?: string;
	/**
	 * Number of commits the registered `lastCommit` is behind the
	 * sibling-clone HEAD, when both refs are known to the cwd's clone.
	 * `undefined` when the comparison cannot be performed (e.g. the
	 * indexed commit isn't reachable from cwd).
	 */
	drift?: number;
	/** Human-readable hint, set whenever the situation warrants warning. */
	hint?: string;
}

