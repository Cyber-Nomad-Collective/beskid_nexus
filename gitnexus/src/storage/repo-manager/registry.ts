import fs from "node:fs/promises";
import path from "node:path";
import { getInferredRepoName, resolveRepoIdentityRoot } from "../git.js";
import type {
	RegisterRepoOptions,
	RegistryEntry,
	RepoMeta,
} from "./contracts.js";
import {
	AnalysisNotFinalizedError,
	RegistryAmbiguousTargetError,
	RegistryNameCollisionError,
	RegistryNotFoundError,
	UnsafeStoragePathError,
} from "./errors.js";
import {
	canonicalizePath,
	getGlobalDir,
	getGlobalRegistryPath,
	getStoragePaths,
} from "./paths.js";

export const readRegistry = async (): Promise<RegistryEntry[]> => {
	try {
		const raw = await fs.readFile(getGlobalRegistryPath(), "utf-8");
		const data = JSON.parse(raw);
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
};

/**
 * Write the global registry to disk
 */
export const writeRegistry = async (entries: RegistryEntry[]): Promise<void> => {
	const dir = getGlobalDir();
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		getGlobalRegistryPath(),
		JSON.stringify(entries, null, 2),
		"utf-8",
	);
};

/** Returns true when a previously-registered entry's `name` differs from
 *  both `path.basename(entry.path)` and the git-remote-derived name —
 *  i.e. a user explicitly aliased it via `analyze --name <alias>` on a
 *  prior run. Used to preserve the alias across re-analyses that omit
 *  `--name`. The remote-derived name is treated as an inference, not a
 *  custom alias, so re-analyses keep tracking remote renames.
 *
 *  `inferredName` is passed in (rather than re-derived) so callers can
 *  avoid a second `git config` subprocess invocation. */
const hasCustomAlias = (
	entry: RegistryEntry,
	inferredName: string | null,
): boolean => {
	const resolved = path.resolve(entry.path);
	if (entry.name === path.basename(resolved)) return false;
	// Canonical-root-derived names are not user aliases either (#1259):
	// a worktree registered under the canonical repo's basename
	// (e.g. `{name: 'repo', path: '/repo/wt-feature'}`) must re-register
	// cleanly without firing the duplicate-name collision guard. Without
	// this check `entry.name = 'repo'` !== `path.basename('/repo/wt-feature') = 'wt-feature'`,
	// so the prior check returns true → `isPreservedAlias = true` → guard
	// throws `RegistryNameCollisionError` against the also-registered
	// canonical checkout entry. The Claude-Code per-task worktree workflow
	// — analyze canonical, then analyze worktree, then re-analyze worktree
	// — would break on the third call.
	if (entry.name === path.basename(resolveRepoIdentityRoot(resolved)))
		return false;
	if (inferredName && entry.name === inferredName) return false;
	return true;
};

/**
 * Register (add or update) a repo in the global registry.
 * Called after `gitnexus analyze` completes.
 *
 * Name resolution precedence (#829, #979):
 *   1. explicit `opts.name` (from `analyze --name <alias>`)
 *   2. preserved alias on an existing entry for this path
 *   3. `git config --get remote.origin.url` repo name (#979 — recovers
 *      a meaningful name for monorepo subprojects, git worktrees, and
 *      Gas-Town-style `<rig>/refinery/rig/` layouts where the basename
 *      is generic)
 *   4. `path.basename(repoPath)` (the original default)
 *
 * Duplicate-name guard: if another path already uses the resolved
 * `name`, throw {@link RegistryNameCollisionError} unless
 * `opts.allowDuplicateName` is set. The guard ONLY fires when the user explicitly passed a
 * `name`; un-aliased basename collisions continue to register silently
 * so existing users who don't know about `--name` see no behaviour
 * change.
 *
 * Returns the `name` that was actually written to the registry — the
 * caller can re-use it to keep AGENTS.md / skill files aligned with the
 * MCP-visible repo name (#979).
 */
export const registerRepo = async (
	repoPath: string,
	meta: RepoMeta,
	opts?: RegisterRepoOptions,
): Promise<string> => {
	// Preserve the caller's chosen path form in the registry — don't
	// canonicalise at write time. This matters for two reasons:
	//   1. `list` and error messages show the path the user actually
	//      knows (e.g. the 8.3 short form they typed), not a runtime-
	//      resolved long form they've never seen.
	//   2. Keeps pre-existing #829 test assertions that compare
	//      `err.existingPath` against `path.resolve(tmpPath)` stable.
	// Canonicalisation is applied at COMPARE points only (see below),
	// which is where the cross-platform divergence actually matters.
	const resolved = path.resolve(repoPath);
	const { storagePath } = getStoragePaths(resolved);

	// Canonical form used strictly for comparison — `realpathSync.native`
	// expands macOS /var → /private/var and Windows 8.3 → long-name,
	// falling back to `path.resolve` when the path doesn't exist.
	const canonicalInput = canonicalizePath(repoPath);

	const entries = await readRegistry();
	const existingIdx = entries.findIndex((e) => {
		// Canonicalise the STORED entry too so pre-canonicalisation
		// registries (written by older versions, or paths passed in a
		// different form) still match correctly. `canonicalizePath` falls
		// back to `path.resolve` when the path no longer exists on disk,
		// so stale entries that have been rm'd externally still resolve
		// to a stable key instead of throwing.
		const a = canonicalizePath(e.path);
		const b = canonicalInput;
		return process.platform === "win32"
			? a.toLowerCase() === b.toLowerCase()
			: a === b;
	});
	const existing = existingIdx >= 0 ? entries[existingIdx] : null;

	// Precedence: explicit --name > preserved alias > remote-inferred > basename.
	// Skip the `git config` subprocess entirely when --name was passed —
	// the remote isn't consulted in that case.
	let name: string;
	let isPreservedAlias = false;
	if (opts?.name !== undefined) {
		name = opts.name;
	} else {
		// Compute the remote-derived name at most once. It feeds both the
		// alias-preservation check (`hasCustomAlias` needs it to distinguish
		// a sticky user alias from a previously-stored remote inference) and
		// the fallback name when neither --name nor a preserved alias apply.
		const inferred = getInferredRepoName(resolved);
		if (existing && hasCustomAlias(existing, inferred)) {
			name = existing.name;
			isPreservedAlias = true;
		} else {
			// Canonical-root fallback: when `resolved` is a worktree root,
			// derive the registry name from the canonical repo's basename, not
			// the worktree slug — see #1259. `resolveRepoIdentityRoot` confines
			// the collapse to canonical checkouts and linked worktree roots only,
			// so `--skip-git` subdirs of unrelated parent git repos keep using
			// their own basename (preserves the #1232/#1233 fix's intent).
			name = inferred ?? path.basename(resolveRepoIdentityRoot(resolved));
		}
	}

	// Duplicate-name guard: only fire when the user EXPLICITLY asked for
	// this name (via opts.name or a preserved alias). Unqualified basename
	// and remote-inferred collisions are preserved for backward-compat —
	// they still register, and the user sees the ambiguity at `-r` / `list`
	// resolution time (which is already improved by the disambiguated error
	// messages and list output #829 ships).
	const explicitName = opts?.name !== undefined || isPreservedAlias;
	if (explicitName && !opts?.allowDuplicateName) {
		// Compare canonical-vs-canonical here too so `/var/foo` and
		// `/private/var/foo` (same repo, different form) aren't treated as
		// two colliding paths.
		const collidingEntry = entries.find(
			(e, i) =>
				i !== existingIdx &&
				e.name.toLowerCase() === name.toLowerCase() &&
				canonicalizePath(e.path) !== canonicalInput,
		);
		if (collidingEntry) {
			throw new RegistryNameCollisionError(name, collidingEntry.path, resolved);
		}
	}

	const entry: RegistryEntry = {
		name,
		path: resolved,
		storagePath,
		indexedAt: meta.indexedAt,
		lastCommit: meta.lastCommit,
		remoteUrl: meta.remoteUrl,
		stats: meta.stats,
	};

	if (existingIdx >= 0) {
		entries[existingIdx] = entry;
	} else {
		entries.push(entry);
	}

	await writeRegistry(entries);
	return name;
};

/**
 * Remove a repo from the global registry.
 * Called after `gitnexus clean`.
 */
export const unregisterRepo = async (repoPath: string): Promise<void> => {
	// Canonicalise BOTH sides so an unregister call issued with the
	// symlink form (`/var/folders/.../repo`) still matches an entry
	// written with the realpath form (`/private/var/folders/.../repo`),
	// and vice versa. Matches the semantics of `registerRepo` and
	// `resolveRegistryEntry` post-#1003 review.
	const resolved = canonicalizePath(repoPath);
	const entries = await readRegistry();
	const matches = (a: string, b: string) =>
		process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	const filtered = entries.filter(
		(e) => !matches(canonicalizePath(e.path), resolved),
	);
	await writeRegistry(filtered);
};
/**
 * Verify that a successful `analyze` call actually produced an indexed,
 * registered repo on disk. Two checks, both strictly required:
 *
 *   1. `meta.json` must exist at `<repoPath>/.gitnexus/meta.json`.
 *   2. The global registry (`getGlobalRegistryPath()`) must contain an
 *      entry whose canonical path matches `repoPath`.
 *
 * Throws {@link AnalysisNotFinalizedError} on the first failure with the
 * specific missing artifact. Pure read — does not mutate disk state.
 *
 * Callers must skip this assertion on the `alreadyUpToDate` early-return
 * path, where the rebuild was deliberately not run.
 */
export const assertAnalysisFinalized = async (
	repoPath: string,
): Promise<void> => {
	const resolved = path.resolve(repoPath);
	const { storagePath, metaPath } = getStoragePaths(resolved);

	try {
		await fs.access(metaPath);
	} catch {
		throw new AnalysisNotFinalizedError(
			resolved,
			storagePath,
			"meta",
			getGlobalRegistryPath(),
		);
	}

	const entries = await readRegistry();
	const canonicalInput = canonicalizePath(resolved);
	const isWin = process.platform === "win32";
	const found = entries.some((e) => {
		const a = canonicalizePath(e.path);
		return isWin
			? a.toLowerCase() === canonicalInput.toLowerCase()
			: a === canonicalInput;
	});
	if (!found) {
		throw new AnalysisNotFinalizedError(
			resolved,
			storagePath,
			"registry-entry",
			getGlobalRegistryPath(),
		);
	}
};


/**
 * Guard rail for destructive CLI paths (`remove` #664,
 * `clean --all` #258, future MCP `remove` tool): verify that a
 * registry entry's `storagePath` is the canonical `<repo>/.gitnexus`
 * subfolder of its `path`. If not, throw {@link UnsafeStoragePathError}
 * so the caller exits without touching disk.
 *
 * Why this exists (#1003 review — @magyargergo):
 *   - `~/.gitnexus/registry.json` is a plain-text user-writable file.
 *     A corrupted, hand-edited, or downgrade/upgrade-racing entry
 *     could plausibly end up with `storagePath === ""` (resolves to
 *     cwd), `storagePath === path` (the repo root!), `storagePath`
 *     equal to a parent/sibling of the repo, or simply any arbitrary
 *     filesystem path.
 *   - `fs.rm(recursive: true, force: true)` on ANY of those would be
 *     a runtime disaster — at best delete the user's working tree, at
 *     worst nuke an unrelated directory tree they happen to own.
 *   - `clean` (default, cwd-scoped) is safe by construction — it
 *     re-derives storagePath from `findRepo(cwd)` and never trusts
 *     the registry field. But `clean --all` DOES iterate the registry
 *     and trust each entry's stored storagePath (same shape as
 *     `remove`), so this helper must be wired into that loop too.
 *   - `server/api.ts` recomputes storagePath from `getStoragePath(entry.path)`
 *     and so is likewise safe-by-construction.
 *
 * Pure string check — does NOT require the paths to exist on disk.
 * Windows: case-insensitive; POSIX: case-sensitive. Matches the
 * comparison shape used elsewhere in this module.
 */
export const assertSafeStoragePath = (entry: RegistryEntry): void => {
	const expected = path.join(path.resolve(entry.path), ".gitnexus");
	const actual = path.resolve(entry.storagePath);
	const matches =
		process.platform === "win32"
			? expected.toLowerCase() === actual.toLowerCase()
			: expected === actual;
	if (!matches) {
		throw new UnsafeStoragePathError(entry, expected, actual);
	}
};
/**
 * Resolve a user-supplied target string (from `gitnexus remove <target>`
 * or equivalent MCP tool argument) to a single registry entry.
 *
 * Match precedence (first hit wins, subsequent tiers are only tried if
 * the prior tier produces zero matches):
 *   1. Exact resolved-path match (Windows: case-insensitive).
 *      Paths are unique by registry construction, so a path match can
 *      never be ambiguous.
 *   2. Exact `name` match (case-insensitive). If ≥ 2 entries share the
 *      name — only possible via `--allow-duplicate-name` (#829) —
 *      throws {@link RegistryAmbiguousTargetError}.
 *
 * No fuzzy / partial matching — unambiguous, scriptable behaviour is
 * more important than convenience for destructive commands.
 *
 * Throws {@link RegistryNotFoundError} if no entry matches.
 *
 * `entries` is passed in (rather than re-read) so callers that already
 * hold the registry snapshot (e.g. to print a "before" state) can avoid
 * a second disk read, and so tests can inject fixtures without touching
 * `GITNEXUS_HOME`.
 */
export const resolveRegistryEntry = (
	entries: RegistryEntry[],
	target: string,
): RegistryEntry => {
	// Tier 1: path match. Canonicalise BOTH sides so symlink and
	// Windows-8.3 quirks don't cause a false miss — e.g. the caller
	// passes `/var/folders/.../repo` while the registry has
	// `/private/var/folders/.../repo` (both resolve to the same
	// `realpath.native`). See `canonicalizePath` for the rationale.
	//
	// Canonicalising the STORED entry (not just the input) is what gives
	// us backward-compat for registries written by versions that only
	// ran `path.resolve` — both get canonicalised here at compare time.
	const canonicalTarget = canonicalizePath(target);
	const pathMatch = entries.find((e) => {
		const a = canonicalizePath(e.path);
		const b = canonicalTarget;
		return process.platform === "win32"
			? a.toLowerCase() === b.toLowerCase()
			: a === b;
	});
	if (pathMatch) return pathMatch;

	// Tier 2: name match. Case-insensitive on all platforms — registry
	// name collisions are already filtered case-insensitively in
	// `registerRepo`, so "APP" vs "app" are considered the same key.
	const targetLower = target.toLowerCase();
	const nameMatches = entries.filter(
		(e) => e.name.toLowerCase() === targetLower,
	);
	if (nameMatches.length === 1) return nameMatches[0];
	if (nameMatches.length > 1) {
		throw new RegistryAmbiguousTargetError(target, nameMatches);
	}

	// Tier 3: miss. Build the available-names hint ONCE; resolveRepo-style
	// disambiguated labels (`app (/path)`) are applied when the same name
	// appears in multiple entries so the user sees the same hint shape as
	// `-r <name>` errors.
	const nameCounts = new Map<string, number>();
	for (const e of entries) {
		const key = e.name.toLowerCase();
		nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
	}
	const availableNames = entries.map((e) =>
		(nameCounts.get(e.name.toLowerCase()) ?? 0) > 1
			? `${e.name} (${e.path})`
			: e.name,
	);
	throw new RegistryNotFoundError(target, availableNames);
};

/**
 * List all registered repos from the global registry.
 * Optionally validates that each entry's .gitnexus/ still exists.
 */
export const listRegisteredRepos = async (opts?: {
	validate?: boolean;
}): Promise<RegistryEntry[]> => {
	const entries = await readRegistry();
	if (!opts?.validate) return entries;

	// Validate each entry still has a .gitnexus/ directory
	const valid: RegistryEntry[] = [];
	for (const entry of entries) {
		try {
			await fs.access(path.join(entry.storagePath, "meta.json"));
			valid.push(entry);
		} catch {
			// Index no longer exists — skip
		}
	}

	// If we pruned any entries, save the cleaned registry
	if (valid.length !== entries.length) {
		await writeRegistry(valid);
	}

	return valid;
};

// ─── Sibling-clone detection ─────────────────────────────────────────────
//
// A "sibling clone" is a different on-disk path that points at the same
// logical repository (same `origin` remote URL) as a registered index.
// This shows up in three operationally important shapes (see issue):
//
//   1. The same repo is checked out under multiple paths (worktrees,
//      multi-agent workspaces). Only one is indexed; the others silently
//      diverge from the graph.
//   2. The indexed clone is itself behind its own HEAD (the existing
//      `checkStaleness` already handles this case).
//   3. A query is issued from a `cwd` that lives inside a sibling clone
//      whose HEAD has drifted from the indexed `lastCommit`.
//
// Detection is intentionally remote-URL-based and does NOT walk the
// filesystem hunting for unregistered clones — only registered entries
// are considered. The `cwd`-driven branch ({@link checkSiblingDrift})
// also accepts an unregistered cwd, because the live caller's working
// directory is the one place we can cheaply learn about an
// unregistered clone.

/**
 * Find other registered entries whose `remoteUrl` matches the given
 * one, excluding `selfPath` (case-insensitive on Windows). Entries
 * without a `remoteUrl` are ignored — we cannot prove sibling-ness
 * without a fingerprint.
 */
export const findSiblingClones = async (
	remoteUrl: string | undefined,
	selfPath: string,
): Promise<RegistryEntry[]> => {
	if (!remoteUrl) return [];
	const entries = await readRegistry();
	const isWin = process.platform === "win32";
	const norm = (p: string) =>
		isWin ? path.resolve(p).toLowerCase() : path.resolve(p);
	const self = norm(selfPath);
	return entries.filter(
		(e) => e.remoteUrl === remoteUrl && norm(e.path) !== self,
	);
};

