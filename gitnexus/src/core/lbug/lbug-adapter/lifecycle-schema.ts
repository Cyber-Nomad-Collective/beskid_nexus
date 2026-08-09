import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import lbug from "@ladybugdb/core";
import { logger } from "../../logger.js";
import { isVectorExtensionSupportedByPlatform } from "../../platform/capabilities.js";
import {
	type ExtensionEnsureOptions,
	extensionManager,
} from "../extension-loader.js";
import {
	isDbBusyError,
	isOpenRetryExhausted,
	openLbugConnection,
	waitForWindowsHandleRelease,
} from "../lbug-config.js";
import { SCHEMA_QUERIES } from "../schema.js";
import {
	drainQueryResult,
	extractErrnoCode,
	isMissingFileError,
	isReadOnlyDbError,
	queryAndDrain,
	readQueryRows,
	summarizeError,
} from "./mapping-errors.js";
import { adapterState } from "./state.js";

const ftsIndexKey = (tableName: string, indexName: string): string =>
	`${tableName}:${indexName}`;
// Global session lock for operations that touch module-level lbug globals.
// This guarantees no DB switch can happen while an operation is running.
/** Number of times to retry on a BUSY / lock-held error before giving up. */
const DB_LOCK_RETRY_ATTEMPTS = 3;
/** Base back-off in ms between BUSY retries (multiplied by attempt number). */
const DB_LOCK_RETRY_DELAY_MS = 500;

/** Maximum age (ms) before an init lock is considered stale. */
const INIT_LOCK_STALE_MS = 30_000;
/** Maximum attempts to acquire the init lock before giving up. */
const INIT_LOCK_MAX_ATTEMPTS = 6;
/** Delay between lock-acquisition retries (ms). */
const INIT_LOCK_RETRY_DELAY_MS = 500;

const initLockPath = (dbPath: string): string => `${dbPath}.init.lock`;

/**
 * Returns true when the process identified by `pid` is still running.
 * Uses `process.kill(pid, 0)` which sends signal 0 (a no-op probe) —
 * it throws ESRCH when the process does not exist.
 */
const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * Try to break a stale lock whose owning process has exited.
 * Returns `true` if the stale lock was removed (caller should retry acquire).
 * Returns `false` if the lock is still valid (another live process owns it).
 */
const tryBreakStaleLock = async (lockPath: string): Promise<boolean> => {
	try {
		const content = await fs.readFile(lockPath, "utf-8");
		const parsed = JSON.parse(content) as { pid?: number; ts?: number };

		// If the owning process is still alive AND the lock is not stale, don't break.
		if (typeof parsed.pid === "number" && isProcessAlive(parsed.pid)) {
			// Even a live process's lock can be stale if it's been held too long
			// (e.g. the process is hung). Check the timestamp.
			if (
				typeof parsed.ts === "number" &&
				Date.now() - parsed.ts < INIT_LOCK_STALE_MS
			) {
				return false;
			}
		}

		// PID is gone or lock exceeded INIT_LOCK_STALE_MS — reclaim it.
		await fs.unlink(lockPath);
		logger.warn(
			`GitNexus: removed stale init lock (pid=${parsed.pid ?? "?"}, age=${typeof parsed.ts === "number" ? `${Date.now() - parsed.ts}ms` : "?"})`,
		);
		return true;
	} catch (err) {
		// Lock file disappeared between our read and unlink, or is unreadable.
		// Either way, let the caller retry the acquire.
		if (isMissingFileError(err)) return true;
		// Permission error or corrupt content — log and let caller retry.
		const code = extractErrnoCode(err);
		logger.warn(
			`GitNexus: unable to inspect init lock (${code ?? "UNKNOWN"}): ${summarizeError(err)}`,
		);
		return false;
	}
};

/**
 * Acquire a cross-process init lock for `dbPath`.
 * Uses `O_CREAT | O_EXCL` for atomic create-or-fail semantics.
 *
 * Returns a release function that removes the lock file. The release
 * function is idempotent and safe to call even if the lock was already
 * cleaned up externally.
 *
 * Throws if the lock cannot be acquired after `INIT_LOCK_MAX_ATTEMPTS`.
 */
export const acquireInitLock = async (
	dbPath: string,
): Promise<() => Promise<void>> => {
	const lockPath = initLockPath(dbPath);
	const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });

	// Ensure the parent directory exists before creating the lock file.
	// On a fresh repo the `.gitnexus/` directory may not exist yet, and
	// fs.open with O_CREAT | O_EXCL would fail with ENOENT.
	await fs.mkdir(path.dirname(lockPath), { recursive: true });

	for (let attempt = 1; attempt <= INIT_LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			const handle = await fs.open(
				lockPath,
				fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
			);
			await handle.writeFile(payload);
			await handle.close();

			// Return the idempotent release function
			return async () => {
				try {
					await fs.unlink(lockPath);
				} catch (err) {
					if (!isMissingFileError(err)) {
						const code = extractErrnoCode(err);
						logger.warn(
							`GitNexus: failed to release init lock (${code ?? "UNKNOWN"}): ${summarizeError(err)}`,
						);
					}
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
				throw err; // Unexpected error — propagate immediately
			}

			// Lock file exists — check if it's stale
			const broken = await tryBreakStaleLock(lockPath);
			if (broken && attempt < INIT_LOCK_MAX_ATTEMPTS) {
				continue; // Stale lock removed — retry immediately
			}

			if (attempt === INIT_LOCK_MAX_ATTEMPTS) {
				throw new Error(
					`GitNexus: unable to acquire init lock after ${INIT_LOCK_MAX_ATTEMPTS} attempts — ` +
						`another gitnexus process may be initializing the same database (${lockPath})`,
				);
			}

			// Live process holds the lock — wait and retry
			await new Promise((resolve) =>
				setTimeout(resolve, INIT_LOCK_RETRY_DELAY_MS),
			);
		}
	}

	// Unreachable — loop always throws or returns
	throw new Error("GitNexus: init lock acquisition failed unexpectedly");
};

/** Exported for testing — returns the lock file path for a given dbPath. */
export const _initLockPathForTest = initLockPath;

const runWithSessionLock = async <T>(
	operation: () => Promise<T>,
): Promise<T> => {
	const previous = adapterState.sessionLock;
	let release: (() => void) | null = null;
	adapterState.sessionLock = new Promise<void>((resolve) => {
		release = resolve;
	});

	await previous;
	try {
		return await operation();
	} finally {
		release?.();
	}
};


export const initLbug = async (dbPath: string) => {
	return runWithSessionLock(() => ensureLbugInitialized(dbPath));
};

/**
 * Execute multiple queries against one repo DB atomically.
 * While the callback runs, no other request can switch the active DB.
 *
 * Automatically retries up to DB_LOCK_RETRY_ATTEMPTS times when the
 * database is busy (e.g. `gitnexus analyze` holds the write lock).
 * Each retry waits DB_LOCK_RETRY_DELAY_MS * attempt milliseconds.
 */
export const withLbugDb = async <T>(
	dbPath: string,
	operation: () => Promise<T>,
): Promise<T> => {
	let lastError: unknown;
	for (let attempt = 1; attempt <= DB_LOCK_RETRY_ATTEMPTS; attempt++) {
		try {
			return await runWithSessionLock(async () => {
				await ensureLbugInitialized(dbPath);
				return operation();
			});
		} catch (err) {
			lastError = err;
			// Skip outer retry when the inner open-retry already exhausted: the
			// ~1.5s open-time budget was just spent, repeating the full reset+
			// reopen cycle would only add 4-5s of tail latency without changing
			// the outcome (both layers consult the same isDbBusyError matcher).
			if (
				!isDbBusyError(err) ||
				isOpenRetryExhausted(err) ||
				attempt === DB_LOCK_RETRY_ATTEMPTS
			) {
				throw err;
			}
			// Close stale connection inside the session lock to prevent race conditions
			// with concurrent operations that might acquire the lock between cleanup steps
			await runWithSessionLock(async () => {
				await safeClose();
				adapterState.currentDbPath = null;
				adapterState.ftsLoaded = false;
				adapterState.vectorExtensionLoaded = false;
				adapterState.ensuredFTSIndexes.clear();
			});
			// Sleep outside the lock — no need to block others while waiting
			await new Promise((resolve) =>
				setTimeout(resolve, DB_LOCK_RETRY_DELAY_MS * attempt),
			);
		}
	}
	// This line is unreachable — the loop either returns or throws inside,
	// but TypeScript needs an explicit throw to satisfy the return type.
	throw lastError;
};

const ensureLbugInitialized = async (dbPath: string) => {
	if (adapterState.conn && adapterState.currentDbPath === dbPath) {
		return { db: adapterState.db, conn: adapterState.conn };
	}
	await doInitLbug(dbPath);
	return { db: adapterState.db, conn: adapterState.conn };
};

const doInitLbug = async (dbPath: string) => {
	// Different database requested — close the old one first
	if (adapterState.conn || adapterState.db) {
		await safeClose();
		adapterState.currentDbPath = null;
		adapterState.ftsLoaded = false;
		adapterState.vectorExtensionLoaded = false;
		adapterState.ensuredFTSIndexes.clear();
	}

	// LadybugDB stores the database as a single file (not a directory).
	// If the path already exists, it must be a valid LadybugDB database file.
	// Remove stale empty directories or files from older versions.
	try {
		const stat = await fs.lstat(dbPath);
		if (stat.isSymbolicLink()) {
			// Never follow symlinks — just remove the link itself
			await fs.unlink(dbPath);
		} else if (stat.isDirectory()) {
			// Verify path is within expected storage directory before deleting
			const realPath = await fs.realpath(dbPath);
			const parentDir = path.dirname(dbPath);
			const realParent = await fs.realpath(parentDir);
			if (!realPath.startsWith(realParent + path.sep) && realPath !== realParent) {
				throw new Error(
					`Refusing to delete ${dbPath}: resolved path ${realPath} is outside storage directory`,
				);
			}
			// Old-style directory database or empty leftover - remove it
			await fs.rm(dbPath, { recursive: true, force: true });
		}
		// If it's a file, assume it's an existing LadybugDB database - LadybugDB will open it
	} catch (err) {
		if (!isMissingFileError(err)) {
			throw err;
		}
		// Path doesn't exist, which is what LadybugDB wants for a new database
	}

	// ---------------------------------------------------------------------------
	// Cross-process critical section: acquire init lock, clean orphan sidecars,
	// and open the database. The lock prevents a TOCTOU race where another
	// process could create a fresh DB between our access() check and the
	// unlink() of stale sidecars.
	// ---------------------------------------------------------------------------
	const releaseInitLock = await acquireInitLock(dbPath);
	try {
		// Crash-recovery cleanup: if the main DB file is missing, stale sidecars
		// from an interrupted run can block fresh opens indefinitely.
		try {
			await fs.access(dbPath);
		} catch (err) {
			if (isMissingFileError(err)) {
				// `.shadow` is documented by LadybugDB checkpointing and `.wal.checkpoint`
				// was observed in the #1618 crash loop that motivated this recovery path.
				const orphanSidecars = [`${dbPath}.shadow`, `${dbPath}.wal.checkpoint`];
				for (const sidecar of orphanSidecars) {
					try {
						await fs.unlink(sidecar);
						logger.warn(
							`GitNexus: removed orphan sidecar ${path.basename(sidecar)} (no main DB file present)`,
						);
					} catch (err) {
						if (isMissingFileError(err)) {
							continue;
						}
						const code = extractErrnoCode(err);
						logger.warn(
							`GitNexus: failed to remove orphan sidecar ${path.basename(sidecar)} (${code ?? "UNKNOWN"}) while main DB file is missing; LadybugDB open may still fail: ${summarizeError(err)}`,
						);
					}
				}
			} else {
				const code = extractErrnoCode(err);
				logger.warn(
					`GitNexus: unable to verify main DB file before orphan sidecar cleanup (${code ?? "UNKNOWN"}); skipping cleanup: ${summarizeError(err)}`,
				);
			}
		}

		// Ensure parent directory exists
		const parentDir = path.dirname(dbPath);
		await fs.mkdir(parentDir, { recursive: true });

		const opened = await openLbugConnection(lbug, dbPath);
		adapterState.db = opened.db;
		adapterState.conn = opened.conn;
	} finally {
		await releaseInitLock();
	}

	for (const schemaQuery of SCHEMA_QUERIES) {
		try {
			await queryAndDrain(adapterState.conn, schemaQuery);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Suppression list:
			//   - "already exists": expected idempotent re-create on existing DBs
			//   - "could not set lock on file": LadybugDB v0.16.1 emits this on
			//     Windows when CREATE NODE TABLE runs against a path that was
			//     just opened (the WAL handle from a fresh Database briefly
			//     contests the table's first-write lock). The table is created
			//     anyway and any genuine cross-process lock contention surfaces
			//     on the next operation via withLbugDb's retry. Logging it here
			//     would just be noise in CI.
			if (!msg.includes("already exists") && !isDbBusyError(err)) {
				logger.warn(`⚠️ Schema creation warning: ${msg.slice(0, 120)}`);
			}
		}
	}

	// FTS powers baseline search, so initialize it with the core DB. VECTOR is
	// only required for semantic embeddings and is probed lazily there.
	await loadFTSExtension();

	adapterState.currentDbPath = dbPath;
	return { db: adapterState.db, conn: adapterState.conn };
};

/**
 * Flush the WAL so all pending writes are visible to subsequent readers.
 *
 * Best-effort: swallows errors from older LadybugDB versions or schemaless
 * databases that do not support the CHECKPOINT command.  A no-op when there
 * is nothing pending, so safe (and cheap) to call unconditionally after any
 * write path.
 *
 * Use this instead of safeClose when the connection must stay open
 * (e.g. the /api/embed handler that keeps serving queries after flushing).
 *
 * @see safeClose — CHECKPOINT + connection/database close
 */
export const flushWAL = async (): Promise<void> => {
	if (!adapterState.conn) return;
	try {
		const checkpointResult = await adapterState.conn.query("CHECKPOINT");
		await drainQueryResult(checkpointResult);
	} catch {
		/* ignore — older LadybugDB or schemaless DB may not accept it */
	}
};

/**
 * Flush the WAL and close the connection and database handles.
 *
 * Consolidates the CHECKPOINT + close pattern into a single function so
 * callers never call adapterState.conn.close() or adapterState.db.close() directly (#1376).
 * An ESLint no-restricted-syntax rule enforces this — see eslint.config.mjs.
 *
 * @see flushWAL — CHECKPOINT-only (connection stays open)
 * @see closeLbug — safeClose + module state reset (full teardown)
 */
export const safeClose = async (): Promise<void> => {
	await flushWAL();
	// Capture before close — adapterState.currentDbPath stays set so the Windows post-close
	// probe below knows which file to wait on.
	const closingDbPath = adapterState.currentDbPath;
	if (adapterState.conn) {
		try {
			// eslint-disable-next-line no-restricted-syntax -- sole authorised close site
			await adapterState.conn.close();
		} catch {
			/* best-effort */
		}
		adapterState.conn = null;
	}
	if (adapterState.db) {
		try {
			// eslint-disable-next-line no-restricted-syntax -- sole authorised close site
			await adapterState.db.close();
		} catch {
			/* best-effort */
		}
		adapterState.db = null;
	}
	// Windows: libuv reports `adapterState.db.close()` resolved before the kernel has
	// released the file handle. A subsequent `new Database(samePath)` in
	// the same process can race the release. The probe (lbug-config.ts)
	// forces any residual lock to surface as EBUSY/EPERM/EACCES so the
	// open-time retry absorbs the lag.
	if (process.platform === "win32" && closingDbPath) {
		const released = await waitForWindowsHandleRelease(closingDbPath);
		if (!released) {
			// Probe exhausted with a lock code still in flight. The next
			// openLbugConnection will absorb whatever residual lag remains, but
			// a chronic warning helps operators spot AV interference (Windows
			// Defender holding the file far past the 250ms budget).
			logger.warn(
				{ dbPath: closingDbPath },
				"⚠️ LadybugDB file handle still locked after close (Windows). If this repeats, check antivirus/Defender exclusions for the GitNexus storage directory.",
			);
		}
	}
};

export const closeLbug = async (): Promise<void> => {
	await safeClose();
	adapterState.currentDbPath = null;
	adapterState.ftsLoaded = false;
	adapterState.vectorExtensionLoaded = false;
	adapterState.ensuredFTSIndexes.clear();
};

export const isLbugReady = (): boolean => adapterState.conn !== null && adapterState.db !== null;
// ============================================================================
// Full-Text Search (FTS) Functions
// ============================================================================

/**
 * Load the FTS extension on the supplied connection (or the singleton
 * writable connection when none is given).
 *
 * Delegates to the shared `ExtensionManager` so install policy (auto /
 * load-only / never), out-of-process bounded INSTALL, and capability
 * caching are owned in one place. The module-level `adapterState.ftsLoaded` flag is
 * kept purely as a per-call short-circuit on the singleton writable
 * connection so repeated callers (e.g. createFTSIndex) avoid an extra
 * `LOAD` round-trip per invocation. Pool adapter callers pass
 * `{ policy: 'load-only' }` so query paths never block on a network install.
 */
export const loadFTSExtension = async (
	targetConn?: lbug.Connection,
	opts: ExtensionEnsureOptions = {},
): Promise<boolean> => {
	const useModuleState = targetConn === undefined;
	if (useModuleState && adapterState.ftsLoaded) return true;

	const c: lbug.Connection | null = targetConn ?? adapterState.conn;
	if (!c) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}

	const loaded = await extensionManager.ensure(
		(sql) => queryAndDrain(c, sql),
		"fts",
		"FTS",
		opts,
	);
	if (loaded && useModuleState) adapterState.ftsLoaded = true;
	return loaded;
};

/**
 * Load the VECTOR extension on the supplied connection (or the singleton
 * writable connection when none is given). Returns false when VECTOR is
 * unavailable so semantic search can fall back to exact scan.
 */
export const loadVectorExtension = async (
	targetConn?: lbug.Connection,
	opts: ExtensionEnsureOptions = {},
): Promise<boolean> => {
	const useModuleState = targetConn === undefined;
	if (useModuleState && adapterState.vectorExtensionLoaded) return true;
	// INSTALL VECTOR crashes with SIGSEGV on Windows: the KuzuDB native extension
	// installer has an unhandled error path on Windows that raises a fatal signal
	// that JS try/catch cannot intercept. Skip loading — vector/embedding search
	// is unavailable but all graph index queries still work. Do NOT set
	// adapterState.vectorExtensionLoaded here: the flag means "successfully loaded", and a
	// subsequent call would otherwise short-circuit to `return true` at the top.
	if (process.platform === "win32") return false;
	if (!isVectorExtensionSupportedByPlatform()) return false;

	const c: lbug.Connection | null = targetConn ?? adapterState.conn;
	if (!c) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}

	const loaded = await extensionManager.ensure(
		(sql) => queryAndDrain(c, sql),
		"VECTOR",
		"VECTOR",
		opts,
	);
	if (loaded && useModuleState) adapterState.vectorExtensionLoaded = true;
	return loaded;
};
/**
 * Create a full-text search index on a table
 * @param tableName - The node table name (e.g., 'File', 'CodeSymbol')
 * @param indexName - Name for the FTS index
 * @param properties - List of properties to index (e.g., ['name', 'code'])
 * @param stemmer - Stemming algorithm (default: 'porter')
 */
export const createFTSIndex = async (
	tableName: string,
	indexName: string,
	properties: string[],
	stemmer: string = "porter",
): Promise<void> => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}

	const key = ftsIndexKey(tableName, indexName);
	if (adapterState.ensuredFTSIndexes.has(key)) return;

	if (!(await loadFTSExtension())) {
		return;
	}

	const propList = properties.map((p) => `'${p}'`).join(", ");
	const query = `CALL CREATE_FTS_INDEX('${tableName}', '${indexName}', [${propList}], stemmer := '${stemmer}')`;

	try {
		await queryAndDrain(adapterState.conn, query);
		adapterState.ensuredFTSIndexes.add(key);
	} catch (e: any) {
		if (e.message?.includes("already exists")) {
			adapterState.ensuredFTSIndexes.add(key);
			return;
		}
		throw e;
	}
};

/**
 * Lazy-create an FTS index, caching the fact in-process.
 *
 * Kept for writable maintenance paths that need to lazily materialize an
 * index. Read-only query paths must not call this; production analysis owns
 * creating the configured search indexes before the database is served.
 *
 * Safe to call repeatedly — the in-process Set guarantees only the first
 * call hits LadybugDB. `closeLbug` clears the cache so re-init starts fresh.
 *
 * Defense in depth: if the active connection is read-only (e.g. the MCP
 * pool adapter), `CREATE_FTS_INDEX` will fail with "Cannot execute write
 * operations in a read-only database". Treat that as a no-op and cache
 * the key so callers don't loop on a path that can never succeed here —
 * the index is owned by `gitnexus analyze` (writable) and either already
 * exists or will be created on the next analyze.
 */
export const ensureFTSIndex = async (
	tableName: string,
	indexName: string,
	properties: string[],
	stemmer: string = "porter",
): Promise<void> => {
	const key = ftsIndexKey(tableName, indexName);
	if (adapterState.ensuredFTSIndexes.has(key)) return;
	try {
		await createFTSIndex(tableName, indexName, properties, stemmer);
	} catch (e) {
		// Read-only DB: writable analyze owns index creation; silently skip
		// and cache so callers don't loop on a path that can never succeed
		// here (the MCP query pool opens DBs read-only by design).
		if (isReadOnlyDbError(e)) {
			adapterState.ensuredFTSIndexes.add(key);
			return;
		}
		throw e;
	}
};

/**
 * Query a full-text search index
 * @param tableName - The node table name
 * @param indexName - FTS index name
 * @param query - Search query string
 * @param limit - Maximum results
 * @param conjunctive - If true, all terms must match (AND); if false, any term matches (OR)
 * @returns Array of { node properties, score }
 */
export const queryFTS = async (
	tableName: string,
	indexName: string,
	query: string,
	limit: number = 20,
	conjunctive: boolean = false,
): Promise<
	Array<{
		nodeId: string;
		name: string;
		filePath: string;
		score: number;
		[key: string]: any;
	}>
> => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}

	// Escape backslashes and single quotes to prevent Cypher injection
	const escapedQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "''");

	const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := ${conjunctive})
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;

	try {
		const queryResult = await adapterState.conn.query(cypher);
		const rows = await readQueryRows(queryResult);

		return rows.map((row: any) => {
			const node = row.node || row[0] || {};
			const score = row.score ?? row[1] ?? 0;
			return {
				nodeId: node.nodeId || node.id || "",
				name: node.name || "",
				filePath: node.filePath || "",
				score: typeof score === "number" ? score : parseFloat(score) || 0,
				...node,
			};
		});
	} catch (e: any) {
		// Return empty if index doesn't exist yet
		if (e.message?.includes("does not exist")) {
			return [];
		}
		throw e;
	}
};

/**
 * Drop an FTS index
 */
export const dropFTSIndex = async (
	tableName: string,
	indexName: string,
): Promise<void> => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}

	try {
		await queryAndDrain(
			adapterState.conn,
			`CALL DROP_FTS_INDEX('${tableName}', '${indexName}')`,
		);
	} catch {
		// Index may not exist
	} finally {
		adapterState.ensuredFTSIndexes.delete(ftsIndexKey(tableName, indexName));
	}
};
