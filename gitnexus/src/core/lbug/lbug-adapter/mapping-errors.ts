import lbug from "@ladybugdb/core";
import { adapterState } from "./state.js";

// Multi-language table names that were created with backticks in CODE_ELEMENT_BASE
// and must always be referenced with backticks in queries
export const BACKTICK_TABLES = new Set([
	"Struct",
	"Enum",
	"Macro",
	"Typedef",
	"Union",
	"Namespace",
	"Trait",
	"Impl",
	"TypeAlias",
	"Const",
	"Static",
	"Property",
	"Record",
	"Delegate",
	"Annotation",
	"Constructor",
	"Template",
	"Module",
]);

export const escapeTableName = (table: string): string => {
	return BACKTICK_TABLES.has(table) ? `\`${table}\`` : table;
};

/**
 * Check if an error indicates a missing column or table (schema-level problem)
 * rather than a transient/connection error. Used for legacy DB fallback logic.
 */
export const isMissingColumnOrTableError = (msg: string): boolean =>
	msg.includes("does not exist") ||
	// Kuzu-specific: "(table|column|property) ... not found" — narrow enough to avoid
	// matching transient errors like "connection not found" or "key not found".
	/(table|column|property).*not found/i.test(msg);

/** Expose the current Database for pool adapter reuse in tests. */
export const getDatabase = (): lbug.Database | null => adapterState.db;

/**
 * Return true when the error message indicates a write was attempted against
 * a read-only LadybugDB connection. The MCP query pool opens DBs read-only,
 * so any path that calls a `CREATE_*` procedure there will surface this
 * (e.g. defensive `ensureFTSIndex` calls). Owners of the writable analyze
 * path should ignore this error — index creation is owned by `gitnexus
 * analyze` and either already happened or will happen on the next run.
 */
export const isReadOnlyDbError = (err: unknown): boolean => {
	const msg = err instanceof Error ? err.message : String(err);
	return /read-only database/i.test(msg);
};

export const isMissingFileError = (err: unknown): boolean => {
	const errno = err as NodeJS.ErrnoException;
	return errno?.code === "ENOENT";
};

export const extractErrnoCode = (err: unknown): string | undefined => {
	const errno = err as NodeJS.ErrnoException;
	return errno?.code;
};

const MAX_LOGGED_ERROR_MESSAGE_LENGTH = 160;

export const summarizeError = (err: unknown): string =>
	(err instanceof Error ? err.message : String(err)).slice(
		0,
		MAX_LOGGED_ERROR_MESSAGE_LENGTH,
	);

// ---------------------------------------------------------------------------
// Cross-process init lock
//
// Prevents a TOCTOU race in orphan sidecar cleanup: between checking that
// the main DB file is missing and unlinking sidecars, another process could
// create a fresh DB. The lock file (`${dbPath}.init.lock`) is created with
// O_CREAT | O_EXCL (atomic create-or-fail) and contains the owning PID +
// timestamp so stale locks from crashed processes can be reclaimed.
// ---------------------------------------------------------------------------

export const normalizeCopyPath = (filePath: string): string =>
	filePath.replace(/\\/g, "/");

const closeQueryResult = async (result: lbug.QueryResult): Promise<void> => {
	try {
		await result.close();
	} catch {
		// Best-effort cleanup only.
	}
};

export const drainQueryResult = async (
	queryResult: lbug.QueryResult | lbug.QueryResult[],
): Promise<void> => {
	const results = Array.isArray(queryResult) ? queryResult : [queryResult];
	let firstError: unknown;
	let hasError = false;
	for (const result of results) {
		try {
			await result.getAll();
		} catch (err) {
			if (!hasError) {
				firstError = err;
				hasError = true;
			}
		} finally {
			await closeQueryResult(result);
		}
	}
	if (hasError) throw firstError;
};

export const readQueryRows = async (
	queryResult: lbug.QueryResult | lbug.QueryResult[],
): Promise<any[]> => {
	const results = Array.isArray(queryResult) ? queryResult : [queryResult];
	let rows: any[] = [];
	let firstError: unknown;
	let hasError = false;
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		try {
			const resultRows = await result.getAll();
			if (i === 0) rows = resultRows;
		} catch (err) {
			if (!hasError) {
				firstError = err;
				hasError = true;
			}
		} finally {
			await closeQueryResult(result);
		}
	}
	if (hasError) throw firstError;
	return rows;
};

export const queryAndDrain = async (
	targetConn: lbug.Connection,
	cypher: string,
): Promise<void> => {
	const queryResult = await targetConn.query(cypher);
	await drainQueryResult(queryResult);
};
