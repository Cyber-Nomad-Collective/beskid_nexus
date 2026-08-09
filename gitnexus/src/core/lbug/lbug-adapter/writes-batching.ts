import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import lbug from "@ladybugdb/core";
import type { KnowledgeGraph } from "../../graph/types.js";
import { logger } from "../../logger.js";
import { streamAllCSVsToDisk } from "../csv-generator.js";
import {
	closeLbugConnection,
	type LbugConnectionHandle,
	openLbugConnection,
} from "../lbug-config.js";
import {
	EMBEDDING_TABLE_NAME,
	NODE_TABLES,
	type NodeTableName,
	REL_TABLE_NAME,
} from "../schema.js";
import type { RelCsvSplitResult, WriteStreamFactory } from "./contracts.js";
import {
	BACKTICK_TABLES,
	escapeTableName,
	normalizeCopyPath,
	queryAndDrain,
	readQueryRows,
} from "./mapping-errors.js";
import { adapterState } from "./state.js";

/**
 * Split a relationship CSV into per-label-pair files on disk.
 *
 * Streams the CSV line-by-line, routing each relationship to a file named
 * `rel_{fromLabel}_{toLabel}.csv`. Handles backpressure correctly: only one
 * drain listener per stream at a time, and readline resumes only when ALL
 * backpressured streams have drained.
 *
 * @param csvPath       Path to the combined relationship CSV
 * @param csvDir        Directory to write per-pair CSV files
 * @param validTables   Set of valid node table names
 * @param getNodeLabel  Function to extract the label from a node ID
 * @param wsFactory     Optional WriteStream factory (defaults to fs.createWriteStream)
 */
export const splitRelCsvByLabelPair = async (
	csvPath: string,
	csvDir: string,
	validTables: Set<string>,
	getNodeLabel: (id: string) => string,
	wsFactory: WriteStreamFactory = (p) => createWriteStream(p, "utf-8"),
): Promise<RelCsvSplitResult> => {
	let relHeader = "";
	const relsByPairMeta = new Map<string, { csvPath: string; rows: number }>();
	const pairWriteStreams = new Map<string, import("fs").WriteStream>();
	let skippedRels = 0;
	let totalValidRels = 0;

	const inputStream = createReadStream(csvPath, "utf-8");
	const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

	// If any pair WriteStream errors (disk full, EMFILE, etc.) or the input
	// stream fails, we need to abort the pending `once(ws, 'drain')` await.
	// An AbortController gives us one signal to cancel all pending waits
	// without a custom state machine.
	const abortOnError = new AbortController();
	let streamError: Error | null = null;
	const markStreamError = (err: Error): void => {
		streamError ??= err;
		abortOnError.abort(err);
	};

	try {
		// `for await (const line of rl)` replaces the old manual
		// on('line')/pause()/resume()/waitingForDrain state machine: readline's
		// async iterator naturally serializes line delivery with our awaits, so
		// at most one ws can be in backpressure at a time and we just await its
		// 'drain' event.
		let isFirst = true;
		for await (const line of rl) {
			if (streamError) throw streamError;
			if (isFirst) {
				relHeader = line;
				isFirst = false;
				continue;
			}
			if (!line.trim()) continue;
			const match = line.match(/"([^"]*)","([^"]*)"/);
			if (!match) {
				skippedRels++;
				continue;
			}
			const fromLabel = getNodeLabel(match[1]);
			const toLabel = getNodeLabel(match[2]);
			if (!validTables.has(fromLabel) || !validTables.has(toLabel)) {
				skippedRels++;
				continue;
			}

			const pairKey = `${fromLabel}|${toLabel}`;
			let ws = pairWriteStreams.get(pairKey);
			if (!ws) {
				const pairCsvPath = path.join(csvDir, `rel_${fromLabel}_${toLabel}.csv`);
				ws = wsFactory(pairCsvPath);
				ws.on("error", markStreamError);
				pairWriteStreams.set(pairKey, ws);
				relsByPairMeta.set(pairKey, { csvPath: pairCsvPath, rows: 0 });
				if (!ws.write(`${relHeader}\n`)) {
					await once(ws, "drain", { signal: abortOnError.signal });
				}
			}

			if (!ws.write(`${line}\n`)) {
				await once(ws, "drain", { signal: abortOnError.signal });
			}
			relsByPairMeta.get(pairKey)!.rows++;
			totalValidRels++;
		}
		if (streamError) throw streamError;
	} catch (err) {
		// Tear down everything so no fd is left dangling. If the abort was caused
		// by a stream error, rethrow that error (more actionable than AbortError).
		for (const ws of pairWriteStreams.values()) ws.destroy();
		inputStream.destroy();
		throw streamError ?? err;
	} finally {
		// Readline 'close' fires before the underlying fs.ReadStream releases its
		// fd — on Windows that race caused ENOTEMPTY on the parent dir.
		// stream/promises.finished is the stdlib "wait until this stream is fully
		// closed" primitive and handles both success and error paths.
		await finished(inputStream).catch(() => {});
	}

	return {
		relHeader,
		relsByPairMeta,
		pairWriteStreams,
		skippedRels,
		totalValidRels,
	};
};
export type LbugProgressCallback = (message: string) => void;

export const loadGraphToLbug = async (
	graph: KnowledgeGraph,
	repoPath: string,
	storagePath: string,
	onProgress?: LbugProgressCallback,
) => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}

	const log = onProgress || (() => {});

	const csvDir = path.join(storagePath, "csv");

	log("Streaming CSVs to disk...");
	const csvResult = await streamAllCSVsToDisk(graph, repoPath, csvDir);

	const validTables = new Set<string>(NODE_TABLES as readonly string[]);
	const getNodeLabel = (nodeId: string): string => {
		if (nodeId.startsWith("comm_")) return "Community";
		if (nodeId.startsWith("proc_")) return "Process";
		return nodeId.split(":")[0];
	};

	// Bulk COPY all node CSVs (sequential — LadybugDB allows only one write txn at a time)
	const nodeFiles = [...csvResult.nodeFiles.entries()];
	const totalSteps = nodeFiles.length + 1; // +1 for relationships
	let stepsDone = 0;

	for (const [table, { csvPath, rows }] of nodeFiles) {
		stepsDone++;
		log(
			`Loading nodes ${stepsDone}/${totalSteps}: ${table} (${rows.toLocaleString()} rows)`,
		);

		const normalizedPath = normalizeCopyPath(csvPath);
		const copyQuery = getCopyQuery(table, normalizedPath);

		try {
			await queryAndDrain(adapterState.conn, copyQuery);
		} catch (_err) {
			try {
				const retryQuery = copyQuery.replace(
					"auto_detect=false)",
					"auto_detect=false, IGNORE_ERRORS=true)",
				);
				await queryAndDrain(adapterState.conn, retryQuery);
			} catch (retryErr) {
				const retryMsg =
					retryErr instanceof Error ? retryErr.message : String(retryErr);
				throw new Error(`COPY failed for ${table}: ${retryMsg.slice(0, 200)}`);
			}
		}
	}

	// Bulk COPY relationships — split by FROM→TO label pair (LadybugDB requires it)
	const {
		relHeader,
		relsByPairMeta,
		pairWriteStreams,
		skippedRels,
		totalValidRels,
	} = await splitRelCsvByLabelPair(
		csvResult.relCsvPath,
		csvDir,
		validTables,
		getNodeLabel,
	);

	// Close all per-pair write streams before COPY. `stream/promises.finished`
	// resolves on the stream's 'finish' event and rejects on 'error' — replaces
	// a hand-rolled promisification with the stdlib primitive.
	await Promise.all(
		Array.from(pairWriteStreams.values()).map(async (ws) => {
			ws.end();
			await finished(ws);
		}),
	);

	const insertedRels = totalValidRels;
	const warnings: string[] = [];
	if (insertedRels > 0) {
		log(
			`Loading edges: ${insertedRels.toLocaleString()} across ${relsByPairMeta.size} types`,
		);

		let pairIdx = 0;
		let failedPairEdges = 0;
		const failedPairCsvPaths = new Set<string>();

		for (const [pairKey, { csvPath: pairCsvPath, rows }] of relsByPairMeta) {
			pairIdx++;
			const [fromLabel, toLabel] = pairKey.split("|");
			const normalizedPath = normalizeCopyPath(pairCsvPath);
			const copyQuery = `COPY ${REL_TABLE_NAME} FROM "${normalizedPath}" (from="${fromLabel}", to="${toLabel}", HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

			if (pairIdx % 5 === 0 || rows > 1000) {
				log(
					`Loading edges: ${pairIdx}/${relsByPairMeta.size} types (${fromLabel} -> ${toLabel})`,
				);
			}

			try {
				await queryAndDrain(adapterState.conn, copyQuery);
			} catch (_err) {
				try {
					const retryQuery = copyQuery.replace(
						"auto_detect=false)",
						"auto_detect=false, IGNORE_ERRORS=true)",
					);
					await queryAndDrain(adapterState.conn, retryQuery);
				} catch (retryErr) {
					const retryMsg =
						retryErr instanceof Error ? retryErr.message : String(retryErr);
					warnings.push(
						`${fromLabel}->${toLabel} (${rows} edges): ${retryMsg.slice(0, 80)}`,
					);
					failedPairEdges += rows;
					failedPairCsvPaths.add(pairCsvPath);
				}
			}
			// Only delete if not in failedPairCsvPaths (needed for fallback)
			if (!failedPairCsvPaths.has(pairCsvPath)) {
				try {
					await fs.unlink(pairCsvPath);
				} catch {}
			}
		}

		if (failedPairCsvPaths.size > 0) {
			log(
				`Inserting ${failedPairEdges} edges individually (missing schema pairs)`,
			);
			// Read failed pair files and merge for fallback inserts
			const allLines: string[] = [relHeader];
			for (const failedPath of failedPairCsvPaths) {
				try {
					const content = await fs.readFile(failedPath, "utf-8");
					const lines = content.split("\n");
					// Skip header line (first) and empty lines
					for (let i = 1; i < lines.length; i++) {
						if (lines[i].trim()) allLines.push(lines[i]);
					}
				} catch {}
				try {
					await fs.unlink(failedPath);
				} catch {}
			}
			if (allLines.length > 1) {
				await fallbackRelationshipInserts(allLines, validTables, getNodeLabel);
			}
		}
	}

	// Cleanup all CSVs
	try {
		await fs.unlink(csvResult.relCsvPath);
	} catch {}
	for (const [, { csvPath }] of csvResult.nodeFiles) {
		try {
			await fs.unlink(csvPath);
		} catch {}
	}
	try {
		const remaining = await fs.readdir(csvDir);
		for (const f of remaining) {
			try {
				await fs.unlink(path.join(csvDir, f));
			} catch {}
		}
	} catch {}
	try {
		await fs.rmdir(csvDir);
	} catch {}

	return { success: true, insertedRels, skippedRels, warnings };
};

// LadybugDB default ESCAPE is '\' (backslash), but our CSV uses RFC 4180 escaping ("" for literal quotes).
// Source code content is full of backslashes which confuse the auto-detection.
// We MUST explicitly set ESCAPE='"' to use RFC 4180 escaping, and disable auto_detect to prevent
// LadybugDB from overriding our settings based on sample rows.
const COPY_CSV_OPTS = `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

/** Fallback: insert relationships one-by-one if COPY fails */
const fallbackRelationshipInserts = async (
	validRelLines: string[],
	validTables: Set<string>,
	getNodeLabel: (id: string) => string,
) => {
	if (!adapterState.conn) return;
	const escapeLabel = (label: string): string => {
		return BACKTICK_TABLES.has(label) ? `\`${label}\`` : label;
	};

	for (let i = 1; i < validRelLines.length; i++) {
		const line = validRelLines[i];
		try {
			const match = line.match(
				/"([^"]*)","([^"]*)","([^"]*)",([0-9.]+),"([^"]*)",([0-9-]+)/,
			);
			if (!match) continue;
			const [, fromId, toId, relType, confidenceStr, reason, stepStr] = match;
			const fromLabel = getNodeLabel(fromId);
			const toLabel = getNodeLabel(toId);
			if (!validTables.has(fromLabel) || !validTables.has(toLabel)) continue;

			const confidence = parseFloat(confidenceStr) || 1.0;
			const step = parseInt(stepStr, 10) || 0;

			const esc = (s: string) =>
				s
					.replace(/'/g, "''")
					.replace(/\\/g, "\\\\")
					.replace(/\n/g, "\\n")
					.replace(/\r/g, "\\r");
			await queryAndDrain(
				adapterState.conn,
				`
        MATCH (a:${escapeLabel(fromLabel)} {id: '${esc(fromId)}' }),
              (b:${escapeLabel(toLabel)} {id: '${esc(toId)}' })
        CREATE (a)-[:${REL_TABLE_NAME} {type: '${esc(relType)}', confidence: ${confidence}, reason: '${esc(reason)}', step: ${step}}]->(b)
      `,
			);
		} catch {
			// skip
		}
	}
};

/** Tables with isExported column (TypeScript/JS-native types) */
const TABLES_WITH_EXPORTED = new Set<string>([
	"Function",
	"Class",
	"Interface",
	"Method",
	"CodeElement",
]);

const getCopyQuery = (table: NodeTableName, filePath: string): string => {
	const t = escapeTableName(table);
	if (table === "File") {
		return `COPY ${t}(id, name, filePath, content) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	if (table === "Folder") {
		return `COPY ${t}(id, name, filePath) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	if (table === "Community") {
		return `COPY ${t}(id, label, heuristicLabel, keywords, description, enrichedBy, cohesion, symbolCount) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	if (table === "Process") {
		return `COPY ${t}(id, label, heuristicLabel, processType, stepCount, communities, entryPointId, terminalId) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	if (table === "Section") {
		return `COPY ${t}(id, name, filePath, startLine, endLine, level, content, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	if (table === "Route") {
		return `COPY ${t}(id, name, filePath, responseKeys, errorKeys, middleware) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	if (table === "Tool") {
		return `COPY ${t}(id, name, filePath, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	if (table === "Method") {
		return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content, description, parameterCount, returnType) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	if (table === "Property") {
		return `COPY ${t}(id, name, filePath, startLine, endLine, content, description, declaredType) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	// TypeScript/JS code element tables have isExported; multi-language tables do not
	if (TABLES_WITH_EXPORTED.has(table)) {
		return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
	}
	// Multi-language tables (Struct, Impl, Trait, Macro, etc.)
	return `COPY ${t}(id, name, filePath, startLine, endLine, content, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
};

/**
 * Insert a single node to LadybugDB
 * @param label - Node type (File, Function, Class, etc.)
 * @param properties - Node properties
 * @param dbPath - Path to LadybugDB database (optional if already initialized)
 */
export const insertNodeToLbug = async (
	label: string,
	properties: Record<string, any>,
	dbPath?: string,
): Promise<boolean> => {
	// Use provided dbPath or fall back to module-level adapterState.db
	const targetDbPath = dbPath || (adapterState.db ? undefined : null);
	if (!targetDbPath && !adapterState.db) {
		throw new Error(
			"LadybugDB not initialized. Provide dbPath or call initLbug first.",
		);
	}

	try {
		const escapeValue = (v: any): string => {
			if (v === null || v === undefined) return "NULL";
			if (typeof v === "number") return String(v);
			// Escape backslashes first (for Windows paths), then single quotes
			return `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}'`;
		};

		// Build INSERT query based on node type
		const t = escapeTableName(label);
		let query: string;

		if (label === "File") {
			query = `CREATE (n:File {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, content: ${escapeValue(properties.content || "")}})`;
		} else if (label === "Folder") {
			query = `CREATE (n:Folder {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}})`;
		} else if (label === "Section") {
			const descPart = properties.description
				? `, description: ${escapeValue(properties.description)}`
				: "";
			query = `CREATE (n:Section {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, level: ${properties.level || 1}, content: ${escapeValue(properties.content || "")}${descPart}})`;
		} else if (TABLES_WITH_EXPORTED.has(label)) {
			const descPart = properties.description
				? `, description: ${escapeValue(properties.description)}`
				: "";
			query = `CREATE (n:${t} {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, isExported: ${!!properties.isExported}, content: ${escapeValue(properties.content || "")}${descPart}})`;
		} else if (label === "Property") {
			const descPart = properties.description
				? `, description: ${escapeValue(properties.description)}`
				: "";
			query = `CREATE (n:${t} {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, content: ${escapeValue(properties.content || "")}${descPart}, declaredType: ${escapeValue(properties.declaredType || "")}})`;
		} else {
			// Multi-language tables (Struct, Impl, Trait, Macro, etc.) — no isExported
			const descPart = properties.description
				? `, description: ${escapeValue(properties.description)}`
				: "";
			query = `CREATE (n:${t} {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, content: ${escapeValue(properties.content || "")}${descPart}})`;
		}

		// Use per-query connection if dbPath provided (avoids lock conflicts)
		if (targetDbPath) {
			const tempHandle = await openLbugConnection(lbug, targetDbPath);
			try {
				await queryAndDrain(tempHandle.conn, query);
				return true;
			} finally {
				await closeLbugConnection(tempHandle);
			}
		} else if (adapterState.conn) {
			// Use existing persistent connection (when called from analyze)
			await queryAndDrain(adapterState.conn, query);
			return true;
		}

		return false;
	} catch (e: any) {
		// Node may already exist or other error
		logger.error({ err: e.message }, `Failed to insert ${label} node:`);
		return false;
	}
};

/**
 * Batch insert multiple nodes to LadybugDB using a single connection
 * @param nodes - Array of {label, properties} to insert
 * @param dbPath - Path to LadybugDB database
 * @returns Object with success count and error count
 */
export const batchInsertNodesToLbug = async (
	nodes: Array<{ label: string; properties: Record<string, any> }>,
	dbPath: string,
): Promise<{ inserted: number; failed: number }> => {
	if (nodes.length === 0) return { inserted: 0, failed: 0 };

	const escapeValue = (v: any): string => {
		if (v === null || v === undefined) return "NULL";
		if (typeof v === "number") return String(v);
		// Escape backslashes first (for Windows paths), then single quotes, then newlines
		return `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}'`;
	};

	// Open a single connection for all inserts
	const tempHandle = await openLbugConnection(lbug, dbPath);
	const tempConn = tempHandle.conn;

	let inserted = 0;
	let failed = 0;

	try {
		for (const { label, properties } of nodes) {
			try {
				let query: string;

				// Use MERGE instead of CREATE for upsert behavior (handles duplicates gracefully)
				const t = escapeTableName(label);
				if (label === "File") {
					query = `MERGE (n:File {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.content = ${escapeValue(properties.content || "")}`;
				} else if (label === "Folder") {
					query = `MERGE (n:Folder {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}`;
				} else if (label === "Section") {
					const descPart = properties.description
						? `, n.description = ${escapeValue(properties.description)}`
						: "";
					query = `MERGE (n:Section {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.level = ${properties.level || 1}, n.content = ${escapeValue(properties.content || "")}${descPart}`;
				} else if (TABLES_WITH_EXPORTED.has(label)) {
					const descPart = properties.description
						? `, n.description = ${escapeValue(properties.description)}`
						: "";
					query = `MERGE (n:${t} {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.isExported = ${!!properties.isExported}, n.content = ${escapeValue(properties.content || "")}${descPart}`;
				} else if (label === "Property") {
					const descPart = properties.description
						? `, n.description = ${escapeValue(properties.description)}`
						: "";
					query = `MERGE (n:${t} {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.content = ${escapeValue(properties.content || "")}${descPart}, n.declaredType = ${escapeValue(properties.declaredType || "")}`;
				} else {
					const descPart = properties.description
						? `, n.description = ${escapeValue(properties.description)}`
						: "";
					query = `MERGE (n:${t} {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.content = ${escapeValue(properties.content || "")}${descPart}`;
				}

				await queryAndDrain(tempConn, query);
				inserted++;
			} catch (_e: any) {
				// Don't console.error here - it corrupts MCP JSON-RPC on stderr
				failed++;
			}
		}
	} finally {
		await closeLbugConnection(tempHandle);
	}

	return { inserted, failed };
};

/**
 * Delete all nodes (and their relationships) for a specific file from LadybugDB
 * @param filePath - The file path to delete nodes for
 * @param dbPath - Optional path to LadybugDB for per-query connection
 * @returns Object with counts of deleted nodes
 */
export const deleteNodesForFile = async (
	filePath: string,
	dbPath?: string,
): Promise<{ deletedNodes: number }> => {
	const usePerQuery = !!dbPath;

	// Set up connection (either use existing or create per-query)
	let tempHandle: LbugConnectionHandle | null = null;
	let tempConn: lbug.Connection | null = null;
	let targetConn: lbug.Connection | null = adapterState.conn;

	if (usePerQuery) {
		tempHandle = await openLbugConnection(lbug, dbPath);
		tempConn = tempHandle.conn;
		targetConn = tempConn;
	} else if (!adapterState.conn) {
		throw new Error(
			"LadybugDB not initialized. Provide dbPath or call initLbug first.",
		);
	}

	try {
		let deletedNodes = 0;
		const escapedPath = filePath.replace(/'/g, "''");

		// Delete nodes from each table that has filePath
		// DETACH DELETE removes the node and all its relationships
		for (const tableName of NODE_TABLES) {
			// Skip tables that don't have filePath (Community, Process)
			if (tableName === "Community" || tableName === "Process") continue;

			try {
				// First count how many we'll delete
				const tn = escapeTableName(tableName);
				const countResult = await targetConn?.query(
					`MATCH (n:${tn}) WHERE n.filePath = '${escapedPath}' RETURN count(n) AS cnt`,
				);
				const rows = await readQueryRows(countResult);
				const count = Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);

				if (count > 0) {
					// Delete nodes (and implicitly their relationships via DETACH)
					await queryAndDrain(
						targetConn!,
						`MATCH (n:${tn}) WHERE n.filePath = '${escapedPath}' DETACH DELETE n`,
					);
					deletedNodes += count;
				}
			} catch (_e) {
				// Some tables may not support this query, skip
			}
		}

		// Also delete any embeddings for nodes in this file
		try {
			await queryAndDrain(
				targetConn!,
				`MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.nodeId STARTS WITH '${escapedPath}' DELETE e`,
			);
		} catch {
			// Embedding table may not exist or nodeId format may differ
		}

		return { deletedNodes };
	} finally {
		// Close per-query connection if used
		if (tempHandle) await closeLbugConnection(tempHandle);
	}
};

/**
 * Drop every Community and Process node (and their MEMBER_OF /
 * STEP_IN_PROCESS edges via DETACH DELETE). Used at the start of an
 * incremental run so the communities and processes phases regenerate
 * them from scratch on the merged graph — required for the
 * "Leiden runs on the FULL graph" correctness invariant.
 */
export const deleteAllCommunitiesAndProcesses = async (): Promise<{
	nodesDeleted: number;
}> => {
	if (!adapterState.conn) {
		throw new Error("LadybugDB not initialized. Call initLbug first.");
	}
	let nodesDeleted = 0;
	for (const label of ["Community", "Process"]) {
		try {
			const countResult = await adapterState.conn.query(
				`MATCH (n:${label}) RETURN count(n) AS cnt`,
			);
			const result = Array.isArray(countResult) ? countResult[0] : countResult;
			const rows = await result.getAll();
			const count = Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);
			if (count > 0) {
				await adapterState.conn.query(`MATCH (n:${label}) DETACH DELETE n`);
				nodesDeleted += count;
			}
		} catch {
			// Table may not exist yet on a freshly-initialized DB — fine.
		}
	}
	return { nodesDeleted };
};
