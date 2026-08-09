import path from "node:path";
import type { RegistryEntry } from "./contracts.js";

/**
 * Thrown by {@link registerRepo} when a requested name is already in
 * use by a DIFFERENT path. The CLI layer surfaces this as an actionable
 * error instead of relying on `.message` string-matching.
 *
 * The colliding alias is exposed as `err.registryName` (not `err.name`).
 * `err.name` keeps its inherited `Error.prototype.name` semantics (the
 * class name) so downstream code can do the usual `err.name ===
 * 'RegistryNameCollisionError'` checks; use the `kind` discriminant or
 * `instanceof RegistryNameCollisionError` for type-safe narrowing.
 */
export class RegistryNameCollisionError extends Error {
	readonly kind = "RegistryNameCollisionError" as const;
	constructor(
		public readonly registryName: string,
		public readonly existingPath: string,
		public readonly requestedPath: string,
	) {
		super(
			`Registry name "${registryName}" is already used by "${existingPath}".\n` +
				`Pass --name <alias> to register "${requestedPath}" under a different name, ` +
				`or --allow-duplicate-name to allow both paths under the same name (leaves -r <name> ambiguous for these two).`,
		);
		this.name = "RegistryNameCollisionError";
	}
}
/**
 * Thrown by {@link resolveRegistryEntry} when no registered repo matches
 * the caller's target string (by alias, basename, remote-inferred name,
 * or resolved path). CLI callers that want idempotent "remove" semantics
 * should catch this and exit 0 with a warning; non-idempotent callers
 * (e.g. MCP tools) can surface the error directly.
 */
export class RegistryNotFoundError extends Error {
	readonly kind = "RegistryNotFoundError" as const;
	constructor(
		public readonly target: string,
		public readonly availableNames: string[],
	) {
		const hint =
			availableNames.length > 0
				? ` Available: ${availableNames.join(", ")}.`
				: " No repositories are currently registered.";
		super(`No registered repo matches "${target}".${hint}`);
		this.name = "RegistryNotFoundError";
	}
}
/**
 * Thrown by {@link resolveRegistryEntry} when the target string matches
 * the `name` of two or more entries — only possible when the user
 * previously registered duplicates via `analyze --name X
 * --allow-duplicate-name` (#829). The error carries enough information
 * for the caller to render an actionable disambiguation hint without
 * string-matching on `.message`.
 *
 * `kind` is a string literal discriminant (same pattern as
 * {@link RegistryNameCollisionError}) so callers can narrow via
 * `err.kind === 'RegistryAmbiguousTargetError'` without importing the
 * class.
 */
export class RegistryAmbiguousTargetError extends Error {
	readonly kind = "RegistryAmbiguousTargetError" as const;
	constructor(
		public readonly target: string,
		public readonly matches: RegistryEntry[],
	) {
		const listing = matches.map((m) => `  - ${m.name}  (${m.path})`).join("\n");
		super(
			`Multiple registered repos match "${target}":\n${listing}\n` +
				`Pass the absolute path instead to disambiguate.`,
		);
		this.name = "RegistryAmbiguousTargetError";
	}
}
/**
 * Thrown by {@link assertAnalysisFinalized} when a successful `analyze`
 * run did not actually persist `meta.json` or did not register the repo
 * in `~/.gitnexus/registry.json` (#1169).
 *
 * Why this exists: on Windows, `gitnexus analyze` has been observed to
 * exit cleanly (code 0) with `lbug.wal` written but no `meta.json`,
 * leaving the repo invisible to `gitnexus list`/`status` and downstream
 * MCP discovery. The only signal to the user was an empty banner —
 * which is indistinguishable from a no-op early return. This invariant
 * fails loudly with an actionable diagnostic so the silent-finalize bug
 * surfaces with a non-zero exit code and a recoverable error message
 * regardless of the upstream root cause (re-exec churn, native module
 * side effects, antivirus, or future regressions).
 */
export class AnalysisNotFinalizedError extends Error {
	readonly kind = "AnalysisNotFinalizedError" as const;
	constructor(
		public readonly repoPath: string,
		public readonly storagePath: string,
		public readonly missing: "meta" | "registry-entry",
		public readonly registryPath: string,
	) {
		const detail =
			missing === "meta"
				? `meta.json was not written to ${path.join(storagePath, "meta.json")}`
				: `registry entry for ${repoPath} was not added to ${registryPath}`;
		super(
			`Analysis did not finalize for ${repoPath}: ${detail}. ` +
				`The on-disk index is incomplete and was not registered. ` +
				`Re-run "gitnexus analyze" — if the problem persists, inspect ` +
				`${storagePath} for a stale lbug.wal that signals an aborted write.`,
		);
		this.name = "AnalysisNotFinalizedError";
	}
}
/**
 * Thrown by {@link assertSafeStoragePath} when a registry entry's
 * `storagePath` does NOT point at the expected `<entry.path>/.gitnexus`
 * subfolder. CLI destructive commands (`remove`, `clean --all`) should
 * catch this and exit non-zero without deleting anything — the usual
 * cause is a corrupted or hand-edited `~/.gitnexus/registry.json`, and
 * proceeding would mean `fs.rm(recursive: true)` on whatever odd path
 * the entry is pointing at.
 */
export class UnsafeStoragePathError extends Error {
	readonly kind = "UnsafeStoragePathError" as const;
	constructor(
		public readonly entry: RegistryEntry,
		public readonly expectedStoragePath: string,
		public readonly actualStoragePath: string,
	) {
		super(
			`Refusing to remove storage path for safety: expected ` +
				`"${expectedStoragePath}" under the repo's .gitnexus subfolder, ` +
				`but the registry entry has "${actualStoragePath}". ` +
				`This usually means the registry entry is corrupted or was ` +
				`hand-edited. Delete the entry manually from ~/.gitnexus/registry.json ` +
				`and re-run analyze.`,
		);
		this.name = "UnsafeStoragePathError";
	}
}

