import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../../core/logger.js";
import {
	GITNEXUS_DIR,
	GITNEXUS_EXCLUDE_ENTRY,
	getStoragePath,
} from "./paths.js";

function isReadOnlyFilesystemError(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException)?.code;
	return code === "EROFS" || code === "EACCES" || code === "EPERM";
}

/**
 * Keep generated index files ignored without modifying the user's root .gitignore.
 */
export const ensureGitNexusIgnored = async (
	repoPath: string,
): Promise<void> => {
	const gitignorePath = path.join(getStoragePath(repoPath), ".gitignore");
	const desired = "*\n";

	// Idempotent fast path: skip the write entirely when the file already has
	// the expected content. Lets this run cleanly on read-only mounts (e.g.
	// the documented Docker workflow with WORKSPACE_DIR bound :ro) when an
	// earlier `analyze` already created the file. See issue #1549.
	try {
		if ((await fs.readFile(gitignorePath, "utf-8")) === desired) {
			await ensureGitInfoExclude(repoPath);
			return;
		}
	} catch (err: any) {
		if (err?.code !== "ENOENT") throw err;
	}

	try {
		await fs.mkdir(path.dirname(gitignorePath), { recursive: true });
		await fs.writeFile(gitignorePath, desired, "utf-8");
	} catch (err: any) {
		if (isReadOnlyFilesystemError(err)) {
			logger.warn(
				{ path: gitignorePath, code: err.code },
				"GitNexus storage filesystem is not writable; skipping .gitnexus/.gitignore. Generated files may appear as untracked in this repo locally.",
			);
		} else {
			throw err;
		}
	}

	await ensureGitInfoExclude(repoPath);
};

const ensureGitInfoExclude = async (repoPath: string): Promise<void> => {
	const gitDirPath = path.join(path.resolve(repoPath), ".git");
	const excludePath = path.join(gitDirPath, "info", "exclude");

	try {
		const gitDir = await fs.stat(gitDirPath);
		if (!gitDir.isDirectory()) return;
	} catch {
		return;
	}

	let content = "";
	try {
		content = await fs.readFile(excludePath, "utf-8");
	} catch (err: any) {
		if (err?.code !== "ENOENT") throw err;
	}

	const excludes = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	if (
		excludes.includes(GITNEXUS_DIR) ||
		excludes.includes(GITNEXUS_EXCLUDE_ENTRY)
	)
		return;

	const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
	try {
		await fs.mkdir(path.dirname(excludePath), { recursive: true });
		await fs.writeFile(
			excludePath,
			`${content}${separator}${GITNEXUS_EXCLUDE_ENTRY}\n`,
			"utf-8",
		);
	} catch (err: any) {
		if (isReadOnlyFilesystemError(err)) {
			logger.warn(
				{ path: excludePath, code: err.code },
				"GitNexus storage filesystem is not writable; skipping .git/info/exclude update. .gitnexus/ may appear as untracked in `git status` locally.",
			);
		} else {
			throw err;
		}
	}
};

