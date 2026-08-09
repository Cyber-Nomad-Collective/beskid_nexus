import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";


/**
 * Normalise a repo path for registry comparison across platforms
 * (#664 review feedback from @evander-wang).
 *
 * Why this exists: `path.resolve` alone is NOT enough for
 * cross-platform registry stability.
 *   - **macOS**: tmpdirs and `/var` are symlinks to `/private/var`.
 *     A child process that stored `/private/var/folders/.../repo` in
 *     the registry cannot later be matched by an outer caller that
 *     supplies the symlink form `/var/folders/.../repo`. `path.resolve`
 *     does not follow symlinks; `realpathSync.native` does.
 *   - **Windows**: GitHub runners surface tmpdirs in 8.3 short-name
 *     form (`RUNNERA~1\...`), but `process.cwd()` often returns the
 *     long form (`runneradmin\...`). `realpathSync.native` normalises
 *     both sides to the long-name canonical path.
 *
 * Fallback behaviour: if the path does not exist on disk (e.g. a user
 * passed `gitnexus remove some-alias` and the alias misses every
 * registry entry, or the caller is resolving a path that was deleted
 * after registration), we return `path.resolve(p)` rather than
 * throwing. This preserves the idempotent-on-missing semantics of
 * `resolveRegistryEntry` / `remove`.
 *
 * Backwards compatibility: this function is applied to BOTH the
 * caller-supplied input AND each stored `entry.path` at compare time
 * inside `resolveRegistryEntry`, so registries written by older
 * versions (where `registerRepo` only ran `path.resolve`) still match
 * correctly. Newly-written entries are canonicalised at write time too
 * so the registry stabilises over analyze/re-analyze cycles.
 */
export const canonicalizePath = (p: string): string => {
	const resolved = path.resolve(p);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
};
export const GITNEXUS_DIR = ".gitnexus";
export const GITNEXUS_EXCLUDE_ENTRY = `${GITNEXUS_DIR}/`;

// ─── Local Storage Helpers ─────────────────────────────────────────────

/**
 * Get the .gitnexus storage path for a repository
 */
export const getStoragePath = (repoPath: string): string => {
	return path.join(path.resolve(repoPath), GITNEXUS_DIR);
};

/**
 * Get paths to key storage files
 */
export const getStoragePaths = (repoPath: string) => {
	const storagePath = getStoragePath(repoPath);
	return {
		storagePath,
		lbugPath: path.join(storagePath, "lbug"),
		metaPath: path.join(storagePath, "meta.json"),
	};
};
// ─── Global Registry (~/.gitnexus/registry.json) ───────────────────────

/**
 * Get the path to the global GitNexus directory
 */
export const getGlobalDir = (): string => {
	return process.env.GITNEXUS_HOME || path.join(os.homedir(), ".gitnexus");
};

/** Directory for server-side git clones (`gitnexus serve` / POST /api/analyze). */
export const getCloneRoot = (): string => path.join(getGlobalDir(), "repos");

/**
 * Get the path to the global registry file
 */
export const getGlobalRegistryPath = (): string => {
	return path.join(getGlobalDir(), "registry.json");
};

/**
 * Read the global registry. Returns empty array if not found.
 */
/**
 * Get the path to the global CLI config file
 */
export const getGlobalConfigPath = (): string => {
	return path.join(getGlobalDir(), "config.json");
};

