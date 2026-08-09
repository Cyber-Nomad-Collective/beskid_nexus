import lbug from "@ladybugdb/core";
import type { CachedEmbedding } from "../../embeddings/types.js";
import { logger } from "../../logger.js";
import {
	EMBEDDING_TABLE_NAME,
	NODE_TABLES,
	REL_TABLE_NAME,
	STALE_HASH_SENTINEL,
} from "../schema.js";
import {
	drainQueryResult,
	escapeTableName,
	isMissingColumnOrTableError,
	readQueryRows,
} from "./mapping-errors.js";
import { adapterState } from "./state.js";

export const executeQuery = async (cypher: string): Promise<any[]> => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}

	const queryResult = await adapterState.conn.query(cypher);
	return await readQueryRows(queryResult);
};

export const streamQuery = async (
	cypher: string,
	onRow: (row: any) => void | Promise<void>,
): Promise<number> => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}

	const queryResult = await adapterState.conn.query(cypher);
	const results = Array.isArray(queryResult) ? queryResult : [queryResult];
	const result = results[0];
	let rowCount = 0;
	let streamError: unknown;

	try {
		while (await result.hasNext()) {
			const row = await result.getNext();
			await onRow(row);
			rowCount++;
		}
		return rowCount;
	} catch (err) {
		streamError = err;
		throw err;
	} finally {
		try {
			await drainQueryResult(results);
		} catch (err) {
			if (streamError === undefined) throw err;
		}
	}
};

/**
 * Execute a single parameterized query (prepare/execute pattern).
 * Prevents Cypher injection by binding values as parameters.
 */
export const executePrepared = async (
	cypher: string,
	params: Record<string, any>,
): Promise<any[]> => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}
	const stmt = await adapterState.conn.prepare(cypher);
	if (!stmt.isSuccess()) {
		const errMsg = await stmt.getErrorMessage();
		throw new Error(`Prepare failed: ${errMsg}`);
	}
	const queryResult = await adapterState.conn.execute(stmt, params);
	return await readQueryRows(queryResult);
};

export const executeWithReusedStatement = async (
	cypher: string,
	paramsList: Array<Record<string, any>>,
): Promise<void> => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}
	if (paramsList.length === 0) return;

	const SUB_BATCH_SIZE = 4;
	for (let i = 0; i < paramsList.length; i += SUB_BATCH_SIZE) {
		const subBatch = paramsList.slice(i, i + SUB_BATCH_SIZE);
		const stmt = await adapterState.conn.prepare(cypher);
		if (!stmt.isSuccess()) {
			const errMsg = await stmt.getErrorMessage();
			throw new Error(`Prepare failed: ${errMsg}`);
		}
		try {
			for (const params of subBatch) {
				await drainQueryResult(await adapterState.conn.execute(stmt, params));
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const queryPreview = cypher.replace(/\s+/g, " ").slice(0, 120);
			throw new Error(
				`Batch execution failed for rows ${i + 1}-${i + subBatch.length}: ${msg} (${queryPreview})`,
			);
		}
		// Note: LadybugDB PreparedStatement doesn't require explicit close()
	}
};

export const getLbugStats = async (): Promise<{
	nodes: number;
	edges: number;
}> => {
	if (!adapterState.conn) return { nodes: 0, edges: 0 };

	let totalNodes = 0;
	for (const tableName of NODE_TABLES) {
		try {
			const queryResult = await adapterState.conn.query(
				`MATCH (n:${escapeTableName(tableName)}) RETURN count(n) AS cnt`,
			);
			const nodeRows = await readQueryRows(queryResult);
			if (nodeRows.length > 0) {
				totalNodes += Number(nodeRows[0]?.cnt ?? nodeRows[0]?.[0] ?? 0);
			}
		} catch {
			// ignore
		}
	}

	let totalEdges = 0;
	try {
		const queryResult = await adapterState.conn.query(
			`MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`,
		);
		const edgeRows = await readQueryRows(queryResult);
		if (edgeRows.length > 0) {
			totalEdges = Number(edgeRows[0]?.cnt ?? edgeRows[0]?.[0] ?? 0);
		}
	} catch {
		// ignore
	}

	return { nodes: totalNodes, edges: totalEdges };
};

/**
 * Load cached embeddings from LadybugDB before a rebuild.
 * Returns all embedding vectors so they can be re-inserted after the graph is reloaded,
 * avoiding expensive re-embedding of unchanged nodes.
 *
 * Detects old schema (no chunkIndex column) and returns empty cache to trigger rebuild.
 */
export const loadCachedEmbeddings = async (): Promise<{
	embeddingNodeIds: Set<string>;
	embeddings: CachedEmbedding[];
}> => {
	if (!adapterState.conn) {
		return { embeddingNodeIds: new Set(), embeddings: [] };
	}

	const embeddingNodeIds = new Set<string>();
	const embeddings: CachedEmbedding[] = [];
	try {
		// Schema migration detection: query with new columns to verify schema version.
		// Old schema only had (nodeId, embedding); new schema adds (id, chunkIndex, startLine, endLine, contentHash).
		// If the query fails (column missing), we return empty cache to force a full rebuild.
		try {
			const check = await adapterState.conn.query(
				`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex LIMIT 1`,
			);
			await readQueryRows(check);
		} catch {
			return { embeddingNodeIds: new Set(), embeddings: [] };
		}

		// Try to read contentHash alongside chunk columns
		let rows: any;
		let hasContentHash = true;
		try {
			rows = await adapterState.conn.query(
				`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding, e.contentHash AS contentHash`,
			);
		} catch (err: any) {
			// Fallback for legacy DBs without contentHash column
			const msg = err?.message ?? "";
			if (isMissingColumnOrTableError(msg)) {
				hasContentHash = false;
				rows = await adapterState.conn.query(
					`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding`,
				);
			} else {
				throw err;
			}
		}
		for (const row of await readQueryRows(rows)) {
			const nodeId = String(row.nodeId ?? row[0] ?? "");
			if (!nodeId) continue;
			embeddingNodeIds.add(nodeId);
			const embedding = row.embedding ?? row[4];
			if (embedding) {
				embeddings.push({
					nodeId,
					chunkIndex: Number(row.chunkIndex ?? row[1] ?? 0),
					startLine: Number(row.startLine ?? row[2] ?? 0),
					endLine: Number(row.endLine ?? row[3] ?? 0),
					embedding: Array.isArray(embedding)
						? embedding.map(Number)
						: Array.from(embedding as any).map(Number),
					contentHash: hasContentHash
						? (row.contentHash ?? row[5] ?? undefined)
						: undefined,
				});
			}
		}
	} catch {
		/* embedding table may not exist */
	}

	return { embeddingNodeIds, embeddings };
};

/**
 * Fetch existing embedding hashes from CodeEmbedding table for incremental embedding.
 * Returns a Map<nodeId, contentHash> suitable for passing to `runEmbeddingPipeline`.
 * Handles legacy DBs without the `contentHash` column (all rows treated as stale with empty hash).
 * Returns undefined if the CodeEmbedding table does not exist.
 *
 * @param execQuery - Cypher query executor (typically pool-adapter's `executeQuery`)
 */
export const fetchExistingEmbeddingHashes = async (
	execQuery: (cypher: string) => Promise<any[]>,
): Promise<Map<string, string> | undefined> => {
	try {
		const rows = await execQuery(
			`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.contentHash AS contentHash`,
		);
		if (!rows || rows.length === 0) return undefined;
		const map = new Map<string, string>();
		for (const r of rows) {
			const nodeId = r.nodeId ?? r[0];
			const chunkIndex = r.chunkIndex ?? r[1];
			const startLine = r.startLine ?? r[2];
			const endLine = r.endLine ?? r[3];
			const hash = r.contentHash ?? r[4] ?? STALE_HASH_SENTINEL;
			if (nodeId) {
				const hasChunkMetadata =
					chunkIndex !== undefined &&
					chunkIndex !== null &&
					startLine !== undefined &&
					startLine !== null &&
					endLine !== undefined &&
					endLine !== null;
				// Empty/null contentHash or missing chunk metadata means legacy row — treat as stale.
				map.set(nodeId, hasChunkMetadata && hash ? hash : STALE_HASH_SENTINEL);
			}
		}
		return map;
	} catch (err: any) {
		const msg = err?.message ?? "";
		if (isMissingColumnOrTableError(msg)) {
			// Legacy rows missing chunk-aware columns — treat every row as stale.
			try {
				const rows = await execQuery(
					`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId`,
				);
				if (!rows || rows.length === 0) return undefined;
				const map = new Map<string, string>();
				for (const r of rows) {
					const nodeId = r.nodeId ?? r[0];
					if (nodeId) map.set(nodeId, STALE_HASH_SENTINEL);
				}
				logger.info(
					`[embed] ${map.size} nodes in legacy DB (missing chunk-aware columns) — all treated as stale`,
				);
				return map;
			} catch (fallbackErr: any) {
				const fallbackMsg = fallbackErr?.message ?? "";
				if (isMissingColumnOrTableError(fallbackMsg)) {
					logger.info(
						`[embed] CodeEmbedding table not yet present — full embedding run (${fallbackMsg})`,
					);
					return undefined;
				}
				throw fallbackErr;
			}
		}
		throw err;
	}
};

export const getEmbeddingTableName = (): string => EMBEDDING_TABLE_NAME;

/**
 * Return the distinct repo-relative paths of files that import
 * `targetFilePath` according to the IMPORTS edges currently in the
 * DB. Used by the incremental writeback path to expand the
 * "files-to-rewrite" set so that files importing a changed file get
 * their edges (which may have been refined by cross-file resolution)
 * re-emitted, rather than left stale in the DB.
 *
 * The DB query reads the *previous* run's state — pre-pipeline, before
 * any nodes are deleted — so the returned importers are "files that
 * USED TO import the target". That's the right set to invalidate:
 * those are the files whose edges in the DB might no longer match
 * what cross-file resolution produces given the changed file's new
 * exports.
 */
export const queryImporters = async (
	targetFilePath: string,
): Promise<string[]> => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}
	const escaped = targetFilePath.replace(/'/g, "''");
	const cypher = `
    MATCH (a)-[r:${REL_TABLE_NAME}]->(b)
    WHERE r.type = 'IMPORTS' AND b.filePath = '${escaped}'
    RETURN DISTINCT a.filePath AS importer
  `;
	try {
		const queryResult = await adapterState.conn.query(cypher);
		const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
		const rows = await result.getAll();
		const out: string[] = [];
		for (const row of rows) {
			const v = (row as { importer?: unknown }).importer;
			if (typeof v === "string" && v.length > 0) out.push(v);
		}
		return out;
	} catch {
		return [];
	}
};
