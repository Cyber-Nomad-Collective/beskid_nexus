import path from "node:path";
import type express from "express";
import {
	type GraphNode,
	type GraphRelationship,
	NODE_TABLES,
} from "gitnexus-shared";

import {
	executePrepared,
	executeQuery,
	streamQuery,
	withLbugDb,
} from "../../core/lbug/lbug-adapter.js";
import { isWriteQuery } from "../../core/lbug/pool-adapter.js";
import { searchFTSFromLbug } from "../../core/search/bm25-index.js";
import { hybridSearch } from "../../core/search/hybrid-search.js";
import { codeDocsByEntityId } from "../nexus/code-doc-store.js";
import type { ServerRouteDeps } from "./contracts.js";
import { requestedRepo } from "./middleware-errors.js";

type GraphStreamRecord =
	| { type: "node"; data: GraphNode }
	| { type: "relationship"; data: GraphRelationship }
	| { type: "error"; error: string };

export class ClientDisconnectedError extends Error {
	constructor() {
		super("Client disconnected during graph stream");
		this.name = "ClientDisconnectedError";
	}
}

export const isIgnorableGraphQueryError = (err: unknown): boolean => {
	const message = err instanceof Error ? err.message : String(err);
	return (
		message.includes("does not exist") ||
		message.includes("not found") ||
		message.includes("No table named")
	);
};

const ensureStreamIsWritable = (
	res: express.Response,
	signal?: AbortSignal,
): void => {
	if (signal?.aborted || res.destroyed || res.writableEnded) {
		throw new ClientDisconnectedError();
	}
};

const waitForDrain = async (
	res: express.Response,
	signal?: AbortSignal,
): Promise<void> => {
	ensureStreamIsWritable(res, signal);

	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			res.off("drain", onDrain);
			res.off("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};

		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onClose = () => {
			cleanup();
			reject(new ClientDisconnectedError());
		};
		const onAbort = () => {
			cleanup();
			reject(new ClientDisconnectedError());
		};

		res.once("drain", onDrain);
		res.once("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });

		if (signal?.aborted || res.destroyed || res.writableEnded) {
			onAbort();
		}
	});

	ensureStreamIsWritable(res, signal);
};

const isClientDisconnectWriteError = (err: unknown): boolean => {
	if (!(err instanceof Error)) return false;
	return (
		(err as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED" ||
		(err as NodeJS.ErrnoException).code === "EPIPE" ||
		(err as NodeJS.ErrnoException).code === "ECONNRESET" ||
		err.message.includes("write after end")
	);
};

export const writeNdjsonRecord = async (
	res: express.Response,
	record: GraphStreamRecord,
	signal?: AbortSignal,
): Promise<void> => {
	ensureStreamIsWritable(res, signal);

	try {
		const canContinue = res.write(`${JSON.stringify(record)}\n`);
		if (!canContinue) {
			await waitForDrain(res, signal);
		}
	} catch (err) {
		if (isClientDisconnectWriteError(err)) {
			throw new ClientDisconnectedError();
		}
		throw err;
	}
};

const buildGraph = async (
	includeContent = false,
	codeDocs: Map<string, import("../nexus/types.js").CodeDocRecord> = new Map(),
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
	const nodes: GraphNode[] = [];
	for (const table of NODE_TABLES) {
		try {
			const rows = await executeQuery(getNodeQuery(table, includeContent));
			for (const row of rows) {
				nodes.push(
					mergeCodeDocIntoNode(
						mapGraphNodeRow(table, row, includeContent),
						codeDocs,
					),
				);
			}
		} catch (err) {
			if (!isIgnorableGraphQueryError(err)) {
				throw err;
			}
		}
	}

	const relationships: GraphRelationship[] = [];
	const relRows = await executeQuery(GRAPH_RELATIONSHIP_QUERY);
	for (const row of relRows) {
		relationships.push(mapGraphRelationshipRow(row));
	}

	return { nodes, relationships };
};

const GRAPH_RELATIONSHIP_QUERY =
	`MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, ` +
	`r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`;

const quoteNodeTable = (table: string): string =>
	`\`${table.replace(/`/g, "``")}\``;

const getNodeQuery = (table: string, includeContent: boolean): string => {
	const tableLabel = quoteNodeTable(table);

	if (table === "File") {
		return includeContent
			? `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`
			: `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
	}
	if (table === "Folder") {
		return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
	}
	if (table === "Community") {
		return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
	}
	if (table === "Process") {
		return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
	}
	if (table === "Route") {
		return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware`;
	}
	if (table === "Tool") {
		return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.description AS description`;
	}
	return includeContent
		? `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`
		: `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
};

const mapGraphNodeRow = (
	table: string,
	row: any,
	includeContent: boolean,
): GraphNode => ({
	id: row.id ?? row[0],
	label: table as GraphNode["label"],
	properties: {
		name: row.name ?? row.label ?? row[1],
		filePath: row.filePath ?? row[2],
		startLine: row.startLine,
		endLine: row.endLine,
		content: includeContent ? row.content : undefined,
		responseKeys: row.responseKeys,
		errorKeys: row.errorKeys,
		middleware: row.middleware,
		heuristicLabel: row.heuristicLabel,
		cohesion: row.cohesion,
		symbolCount: row.symbolCount,
		description: row.description,
		processType: row.processType,
		stepCount: row.stepCount,
		communities: row.communities,
		entryPointId: row.entryPointId,
		terminalId: row.terminalId,
	} as GraphNode["properties"],
});

const mergeCodeDocIntoNode = (
	node: GraphNode,
	codeDocs: Map<string, import("../nexus/types.js").CodeDocRecord>,
): GraphNode => {
	const record = codeDocs.get(node.id);
	if (!record) return node;
	return {
		...node,
		properties: {
			...node.properties,
			codeDoc: record.codeDoc,
			specLinks: record.specLinks,
		} as GraphNode["properties"],
	};
};

const mapGraphRelationshipRow = (row: any): GraphRelationship => ({
	id: `${row.sourceId}_${row.type}_${row.targetId}`,
	type: row.type,
	sourceId: row.sourceId,
	targetId: row.targetId,
	confidence: row.confidence,
	reason: row.reason,
	step: row.step,
});

export const streamGraphNdjson = async (
	res: express.Response,
	includeContent = false,
	signal?: AbortSignal,
	codeDocs: Map<string, import("../nexus/types.js").CodeDocRecord> = new Map(),
): Promise<void> => {
	for (const table of NODE_TABLES) {
		try {
			await streamQuery(getNodeQuery(table, includeContent), async (row) => {
				await writeNdjsonRecord(
					res,
					{
						type: "node",
						data: mergeCodeDocIntoNode(
							mapGraphNodeRow(table, row, includeContent),
							codeDocs,
						),
					},
					signal,
				);
			});
		} catch (err) {
			if (!isIgnorableGraphQueryError(err)) {
				throw err;
			}
		}
	}

	await streamQuery(GRAPH_RELATIONSHIP_QUERY, async (row) => {
		await writeNdjsonRecord(
			res,
			{
				type: "relationship",
				data: mapGraphRelationshipRow(row),
			},
			signal,
		);
	});
};

/**
 * Mount an SSE progress endpoint for a JobManager.
 * Handles: initial state, terminal events, heartbeat, event IDs, client disconnect.
 */

export const registerGraphSearchRoutes = (deps: Pick<ServerRouteDeps, "app" | "resolveRepo">): void => {
	const { app, resolveRepo } = deps;

	// Get full graph
	app.get("/api/graph", async (req, res) => {
		try {
			const entry = await resolveRepo(requestedRepo(req));
			if (!entry) {
				res.status(404).json({ error: "Repository not found" });
				return;
			}
			const lbugPath = path.join(entry.storagePath, "lbug");
			const includeContent = req.query.includeContent === "true";
			const stream = req.query.stream === "true";
			const codeDocs = await codeDocsByEntityId(entry.name);

			if (stream) {
				const abortController = new AbortController();
				let responseFinished = false;
				const markFinished = () => {
					responseFinished = true;
				};
				const abortStreaming = () => {
					if (!responseFinished) {
						abortController.abort();
					}
				};

				res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
				res.setHeader("Cache-Control", "no-cache");
				res.flushHeaders();

				req.once("aborted", abortStreaming);
				res.once("finish", markFinished);
				res.once("close", abortStreaming);

				try {
					await withLbugDb(lbugPath, async () =>
						streamGraphNdjson(res, includeContent, abortController.signal, codeDocs),
					);
					if (!abortController.signal.aborted && !res.writableEnded) {
						res.end();
					}
				} finally {
					req.off("aborted", abortStreaming);
					res.off("finish", markFinished);
					res.off("close", abortStreaming);
				}
				return;
			}

			const graph = await withLbugDb(lbugPath, async () =>
				buildGraph(includeContent, codeDocs),
			);
			res.json(graph);
		} catch (err: any) {
			if (err instanceof ClientDisconnectedError) {
				return;
			}
			const message = err.message || "Failed to build graph";
			if (res.headersSent) {
				try {
					res.write(`${JSON.stringify({ type: "error", error: message })}\n`);
				} catch {
					// Best-effort only after streaming has started.
				}
				res.end();
				return;
			}
			res.status(500).json({ error: message });
		}
	});

	// Execute Cypher query
	app.post("/api/query", async (req, res) => {
		try {
			const cypher = req.body.cypher as string;
			if (!cypher) {
				res.status(400).json({ error: 'Missing "cypher" in request body' });
				return;
			}

			if (isWriteQuery(cypher)) {
				res
					.status(403)
					.json({ error: "Write queries are not allowed via the HTTP API" });
				return;
			}

			const entry = await resolveRepo(requestedRepo(req));
			if (!entry) {
				res.status(404).json({ error: "Repository not found" });
				return;
			}
			const lbugPath = path.join(entry.storagePath, "lbug");
			const result = await withLbugDb(lbugPath, () => executeQuery(cypher));
			res.json({ result });
		} catch (err: any) {
			res.status(500).json({ error: err.message || "Query failed" });
		}
	});

	// Search (supports mode: 'hybrid' | 'semantic' | 'bm25', and optional enrichment)
	app.post("/api/search", async (req, res) => {
		try {
			const query = (req.body.query ?? "").trim();
			if (!query) {
				res.status(400).json({ error: 'Missing "query" in request body' });
				return;
			}

			const entry = await resolveRepo(requestedRepo(req));
			if (!entry) {
				res.status(404).json({ error: "Repository not found" });
				return;
			}
			const lbugPath = path.join(entry.storagePath, "lbug");
			const parsedLimit = Number(req.body.limit ?? 10);
			const limit = Number.isFinite(parsedLimit)
				? Math.max(1, Math.min(100, Math.trunc(parsedLimit)))
				: 10;
			const mode: string = req.body.mode ?? "hybrid";
			const enrich: boolean = req.body.enrich !== false; // default true

			const results = await withLbugDb(lbugPath, async () => {
				let searchResults: any[];
				let ftsAvailable: boolean | undefined;

				if (mode === "semantic") {
					const { isEmbedderReady } = await import("../../core/embeddings/embedder.js");
					if (!isEmbedderReady()) {
						return { searchResults: [] as any[], ftsAvailable: undefined };
					}
					const { semanticSearch: semSearch } = await import(
						"../../core/embeddings/embedding-pipeline.js"
					);
					searchResults = await semSearch(executeQuery, query, limit);
					// Normalize semantic results to HybridSearchResult shape
					searchResults = searchResults.map((r: any, i: number) => ({
						...r,
						score: r.score ?? 1 - (r.distance ?? 0),
						rank: i + 1,
						sources: ["semantic"],
					}));
				} else if (mode === "bm25") {
					const ftsResponse = await searchFTSFromLbug(query, limit);
					ftsAvailable = ftsResponse.ftsAvailable;
					searchResults = ftsResponse.results.map((r: any, i: number) => ({
						...r,
						rank: i + 1,
						sources: ["bm25"],
					}));
				} else {
					// hybrid (default)
					const { isEmbedderReady } = await import("../../core/embeddings/embedder.js");
					if (isEmbedderReady()) {
						const { semanticSearch: semSearch } = await import(
							"../../core/embeddings/embedding-pipeline.js"
						);
						searchResults = await hybridSearch(query, limit, executeQuery, semSearch);
					} else {
						const ftsResponse = await searchFTSFromLbug(query, limit);
						ftsAvailable = ftsResponse.ftsAvailable;
						searchResults = ftsResponse.results;
					}
				}

				if (!enrich) return { searchResults, ftsAvailable };

				// Server-side enrichment: add connections, cluster, processes per result
				// Uses parameterized queries to prevent Cypher injection via nodeId
				const validLabel = (label: string): boolean =>
					(NODE_TABLES as readonly string[]).includes(label);

				const enriched = await Promise.all(
					searchResults.slice(0, limit).map(async (r: any) => {
						const nodeId: string = r.nodeId || r.id || "";
						const nodeLabel = nodeId.split(":")[0];
						const enrichment: {
							connections?: any;
							cluster?: string;
							processes?: any[];
						} = {};

						if (!nodeId || !validLabel(nodeLabel)) return { ...r, ...enrichment };

						// Run connections, cluster, and process queries in parallel
						// Label is validated against NODE_TABLES (compile-time safe identifiers);
						// nodeId uses $nid parameter binding to prevent injection
						const [connRes, clusterRes, procRes] = await Promise.all([
							executePrepared(
								`
              MATCH (n:${nodeLabel} {id: $nid})
              OPTIONAL MATCH (n)-[r1:CodeRelation]->(dst)
              OPTIONAL MATCH (src)-[r2:CodeRelation]->(n)
              RETURN
                collect(DISTINCT {name: dst.name, type: r1.type, confidence: r1.confidence}) AS outgoing,
                collect(DISTINCT {name: src.name, type: r2.type, confidence: r2.confidence}) AS incoming
              LIMIT 1
            `,
								{ nid: nodeId },
							).catch(() => []),
							executePrepared(
								`
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
              RETURN c.label AS label, c.description AS description
              LIMIT 1
            `,
								{ nid: nodeId },
							).catch(() => []),
							executePrepared(
								`
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[rel:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
              RETURN p.id AS id, p.label AS label, rel.step AS step, p.stepCount AS stepCount
              ORDER BY rel.step
            `,
								{ nid: nodeId },
							).catch(() => []),
						]);

						if (connRes.length > 0) {
							const row = connRes[0];
							const outgoing = (Array.isArray(row) ? row[0] : row.outgoing || [])
								.filter((c: any) => c?.name)
								.slice(0, 5);
							const incoming = (Array.isArray(row) ? row[1] : row.incoming || [])
								.filter((c: any) => c?.name)
								.slice(0, 5);
							enrichment.connections = { outgoing, incoming };
						}

						if (clusterRes.length > 0) {
							const row = clusterRes[0];
							enrichment.cluster = Array.isArray(row) ? row[0] : row.label;
						}

						if (procRes.length > 0) {
							enrichment.processes = procRes
								.map((row: any) => ({
									id: Array.isArray(row) ? row[0] : row.id,
									label: Array.isArray(row) ? row[1] : row.label,
									step: Array.isArray(row) ? row[2] : row.step,
									stepCount: Array.isArray(row) ? row[3] : row.stepCount,
								}))
								.filter((p: any) => p.id && p.label);
						}

						return { ...r, ...enrichment };
					}),
				);

				return { searchResults: enriched, ftsAvailable };
			});
			const response: any = { results: results.searchResults ?? results };
			if (results.ftsAvailable === false) {
				response.warning =
					"FTS indexes missing — keyword search degraded. Run: gitnexus analyze --force to rebuild indexes.";
			}
			res.json(response);
		} catch (err: any) {
			res.status(500).json({ error: err.message || "Search failed" });
		}
	});

}
