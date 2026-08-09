import fs from "node:fs/promises";
import path from "node:path";
import type {
	CLIConfig,
	IndexedRepo,
	RepoMeta,
} from "./contracts.js";
import {
	getGlobalConfigPath,
	getGlobalDir,
	getStoragePaths,
} from "./paths.js";

/**
 * Check whether a KuzuDB index exists in the given storage path.
 * Non-destructive — safe to call from status commands.
 */
export const hasKuzuIndex = async (storagePath: string): Promise<boolean> => {
	try {
		await fs.stat(path.join(storagePath, "kuzu"));
		return true;
	} catch {
		return false;
	}
};

/**
 * Clean up stale KuzuDB files after migration to LadybugDB.
 *
 * Returns:
 *   found        — true if .gitnexus/kuzu existed and was deleted
 *   needsReindex — true if kuzu existed but lbug does not (re-analyze required)
 *
 * Callers own the user-facing messaging; this function only deletes files.
 */
export const cleanupOldKuzuFiles = async (
	storagePath: string,
): Promise<{ found: boolean; needsReindex: boolean }> => {
	const oldPath = path.join(storagePath, "kuzu");
	const newPath = path.join(storagePath, "lbug");
	try {
		await fs.stat(oldPath);
		// Old kuzu file/dir exists — determine if lbug is already present
		let needsReindex = false;
		try {
			await fs.stat(newPath);
		} catch {
			needsReindex = true;
		}
		// Delete kuzu database file and its sidecars (.wal, .lock)
		for (const suffix of ["", ".wal", ".lock"]) {
			try {
				await fs.unlink(oldPath + suffix);
			} catch {}
		}
		// Also handle the case where kuzu was stored as a directory
		try {
			await fs.rm(oldPath, { recursive: true, force: true });
		} catch {}
		return { found: true, needsReindex };
	} catch {
		// Old path doesn't exist — nothing to do
		return { found: false, needsReindex: false };
	}
};

/**
 * Load metadata from an indexed repo
 */
export const loadMeta = async (
	storagePath: string,
): Promise<RepoMeta | null> => {
	try {
		const metaPath = path.join(storagePath, "meta.json");
		const raw = await fs.readFile(metaPath, "utf-8");
		return JSON.parse(raw) as RepoMeta;
	} catch {
		return null;
	}
};

/**
 * Save metadata to storage.
 *
 * Atomic via tmp-file + rename (matches `saveParseCache`'s pattern). The
 * `incrementalInProgress` dirty flag travels through this file — a crash
 * mid-write would leave a corrupt `meta.json` that the next run's
 * `loadMeta` would silently treat as "no prior index", losing the dirty
 * flag and skipping the recovery full-rebuild. Write-and-rename rules
 * that out: the rename is atomic on POSIX and on Windows (`fs.rename`
 * on `node:fs/promises` uses `MoveFileEx(REPLACE_EXISTING)`), so either
 * the old or the new file is observed at every moment.
 */
export const saveMeta = async (
	storagePath: string,
	meta: RepoMeta,
): Promise<void> => {
	await fs.mkdir(storagePath, { recursive: true });
	const metaPath = path.join(storagePath, "meta.json");
	const tmpPath = `${metaPath}.tmp`;
	await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
	await fs.rename(tmpPath, metaPath);
};

/**
 * Check if a path has a GitNexus index
 */
export const hasIndex = async (repoPath: string): Promise<boolean> => {
	const { metaPath } = getStoragePaths(repoPath);
	try {
		await fs.access(metaPath);
		return true;
	} catch {
		return false;
	}
};

/**
 * Load an indexed repo from a path
 */
export const loadRepo = async (
	repoPath: string,
): Promise<IndexedRepo | null> => {
	const paths = getStoragePaths(repoPath);
	const meta = await loadMeta(paths.storagePath);
	if (!meta) return null;

	return {
		repoPath: path.resolve(repoPath),
		...paths,
		meta,
	};
};

/**
 * Find .gitnexus by walking up from a starting path
 */
export const findRepo = async (
	startPath: string,
): Promise<IndexedRepo | null> => {
	let current = path.resolve(startPath);
	const root = path.parse(current).root;

	while (current !== root) {
		const repo = await loadRepo(current);
		if (repo) return repo;
		current = path.dirname(current);
	}

	return null;
};
/**
 * Load CLI config from ~/.gitnexus/config.json
 */
export const loadCLIConfig = async (): Promise<CLIConfig> => {
	try {
		const raw = await fs.readFile(getGlobalConfigPath(), "utf-8");
		return JSON.parse(raw) as CLIConfig;
	} catch {
		return {};
	}
};

/**
 * Save CLI config to ~/.gitnexus/config.json
 */
export const saveCLIConfig = async (config: CLIConfig): Promise<void> => {
	const dir = getGlobalDir();
	await fs.mkdir(dir, { recursive: true });
	const configPath = getGlobalConfigPath();
	await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
	// Restrict file permissions on Unix (config may contain API keys)
	if (process.platform !== "win32") {
		try {
			await fs.chmod(configPath, 0o600);
		} catch {
			/* best-effort */
		}
	}
};

