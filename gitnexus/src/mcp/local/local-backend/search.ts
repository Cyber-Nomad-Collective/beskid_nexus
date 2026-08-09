import { LifecycleBackend } from "./lifecycle.js";
import {
	type RepoHandle,
	VALID_NODE_LABELS,
	logQueryError,
	logQueryTiming,
} from "./formatting-errors.js";
import path from "node:path";
import {
	executeParameterized,
	executeQuery,
} from "../../../core/lbug/pool-adapter.js";
import {
	type ExactEmbeddingRow,
	rankExactEmbeddingRows,
} from "../../../core/embeddings/exact-search.js";
import { collectBestChunks } from "../../../core/embeddings/types.js";
import {
	EMBEDDING_INDEX_NAME,
	EMBEDDING_TABLE_NAME,
} from "../../../core/lbug/schema.js";
import { logger } from "../../../core/logger.js";
import {
	getExactScanLimit,
	isVectorExtensionSupportedByPlatform,
} from "../../../core/platform/capabilities.js";
import { PhaseTimer } from "../../../core/search/phase-timer.js";

export class SearchBackend extends LifecycleBackend {
	protected async query(
		repo: RepoHandle,
		params: {
			query: string;
			task_context?: string;
			goal?: string;
			limit?: number;
			max_symbols?: number;
			include_content?: boolean;
		},
	): Promise<any> {
		if (!params.query?.trim()) {
			return { error: "query parameter is required and cannot be empty." };
		}

		await this.ensureInitialized(repo.id);

		const processLimit = params.limit || 5;
		const maxSymbolsPerProcess = params.max_symbols || 10;
		const includeContent = params.include_content ?? false;
		const searchQuery = params.query.trim();

		// Per-phase timing instrumentation (#553). Records wall time for each
		// observable sub-step of the search pipeline so production latency can
		// be aggregated offline for Pareto analysis and bottleneck detection.
		// Overhead is <0.1 ms per phase; the timer is passive and never alters
		// query behaviour.
		const timer = new PhaseTimer();
		const wallStart = performance.now();

		// Step 1: Run hybrid search to get matching symbols. BM25 and vector
		// search run concurrently via Promise.all — use `timer.time()` for
		// each so both get independent wall-time records without fighting
		// over a single `current` phase slot.
		const searchLimit = processLimit * maxSymbolsPerProcess; // fetch enough raw results
		const [bm25SearchResult, semanticResults] = await Promise.all([
			timer.time("bm25", this.bm25Search(repo, searchQuery, searchLimit)),
			timer.time("vector", this.semanticSearch(repo, searchQuery, searchLimit)),
		]);

		// Guard against undefined results (#1489) — when FTS is entirely
		// unavailable the search helper may return an unexpected shape.
		const bm25Results = bm25SearchResult?.results ?? [];
		const ftsUsed = bm25SearchResult?.ftsUsed ?? false;

		// Merge via reciprocal rank fusion
		timer.start("merge");
		const scoreMap = new Map<string, { score: number; data: any }>();

		for (let i = 0; i < bm25Results.length; i++) {
			const result = bm25Results[i];
			const key = result.nodeId || result.filePath;
			const rrfScore = 1 / (60 + i);
			const existing = scoreMap.get(key);
			if (existing) {
				existing.score += rrfScore;
			} else {
				scoreMap.set(key, { score: rrfScore, data: result });
			}
		}

		const safeSemanticResults = semanticResults ?? [];
		for (let i = 0; i < safeSemanticResults.length; i++) {
			const result = safeSemanticResults[i];
			const key = result.nodeId || result.filePath;
			const rrfScore = 1 / (60 + i);
			const existing = scoreMap.get(key);
			if (existing) {
				existing.score += rrfScore;
			} else {
				scoreMap.set(key, { score: rrfScore, data: result });
			}
		}

		const merged = Array.from(scoreMap.entries())
			.sort((a, b) => b[1].score - a[1].score)
			.slice(0, searchLimit);
		timer.stop(); // merge

		// Step 2: For each match with a nodeId, trace to process(es)
		timer.start("symbol_lookup");
		const processMap = new Map<
			string,
			{
				id: string;
				label: string;
				heuristicLabel: string;
				processType: string;
				stepCount: number;
				totalScore: number;
				cohesionBoost: number;
				symbols: any[];
			}
		>();
		const definitions: any[] = []; // standalone symbols not in any process

		for (const [_, item] of merged) {
			const sym = item.data;
			if (!sym.nodeId) {
				// File-level results go to definitions
				definitions.push({
					name: sym.name,
					type: sym.type || "File",
					filePath: sym.filePath,
				});
				continue;
			}

			// Find processes this symbol participates in
			let processRows: any[] = [];
			try {
				processRows = await executeParameterized(
					repo.id,
					`
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
					{ nodeId: sym.nodeId },
				);
			} catch (e) {
				logQueryError("query:process-lookup", e);
			}

			// Get cluster membership + cohesion (cohesion used as internal ranking signal)
			let cohesion = 0;
			let module: string | undefined;
			try {
				const cohesionRows = await executeParameterized(
					repo.id,
					`
          MATCH (n {id: $nodeId})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.cohesion AS cohesion, c.heuristicLabel AS module
          LIMIT 1
        `,
					{ nodeId: sym.nodeId },
				);
				if (cohesionRows.length > 0) {
					cohesion = (cohesionRows[0].cohesion ?? cohesionRows[0][0]) || 0;
					module = cohesionRows[0].module ?? cohesionRows[0][1];
				}
			} catch (e) {
				logQueryError("query:cluster-info", e);
			}

			// Optionally fetch content
			let content: string | undefined;
			if (includeContent) {
				try {
					const contentRows = await executeParameterized(
						repo.id,
						`
            MATCH (n {id: $nodeId})
            RETURN n.content AS content
          `,
						{ nodeId: sym.nodeId },
					);
					if (contentRows.length > 0) {
						content = contentRows[0].content ?? contentRows[0][0];
					}
				} catch (e) {
					logQueryError("query:content-fetch", e);
				}
			}

			const symbolEntry = {
				id: sym.nodeId,
				name: sym.name,
				type: sym.type,
				filePath: sym.filePath,
				startLine: sym.startLine,
				endLine: sym.endLine,
				...(module ? { module } : {}),
				...(includeContent && content ? { content } : {}),
			};

			if (processRows.length === 0) {
				// Symbol not in any process — goes to definitions
				definitions.push(symbolEntry);
			} else {
				// Add to each process it belongs to
				for (const row of processRows) {
					const pid = row.pid ?? row[0];
					const label = row.label ?? row[1];
					const hLabel = row.heuristicLabel ?? row[2];
					const pType = row.processType ?? row[3];
					const stepCount = row.stepCount ?? row[4];
					const step = row.step ?? row[5];

					if (!processMap.has(pid)) {
						processMap.set(pid, {
							id: pid,
							label,
							heuristicLabel: hLabel,
							processType: pType,
							stepCount,
							totalScore: 0,
							cohesionBoost: 0,
							symbols: [],
						});
					}

					const proc = processMap.get(pid)!;
					proc.totalScore += item.score;
					proc.cohesionBoost = Math.max(proc.cohesionBoost, cohesion);
					proc.symbols.push({
						...symbolEntry,
						process_id: pid,
						step_index: step,
					});
				}
			}
		}

		timer.stop(); // symbol_lookup

		// Step 3: Rank processes by aggregate score + internal cohesion boost
		timer.start("ranking");
		const rankedProcesses = Array.from(processMap.values())
			.map((p) => ({
				...p,
				priority: p.totalScore + p.cohesionBoost * 0.1, // cohesion as subtle ranking signal
			}))
			.sort((a, b) => b.priority - a.priority)
			.slice(0, processLimit);
		timer.stop(); // ranking

		// Step 4: Build response
		timer.start("formatting");
		const processes = rankedProcesses.map((p) => ({
			id: p.id,
			summary: p.heuristicLabel || p.label,
			priority: Math.round(p.priority * 1000) / 1000,
			symbol_count: p.symbols.length,
			process_type: p.processType,
			step_count: p.stepCount,
		}));

		const processSymbols = rankedProcesses.flatMap((p) =>
			p.symbols.slice(0, maxSymbolsPerProcess).map((s) => ({
				...s,
				// remove internal fields
			})),
		);

		// Deduplicate process_symbols by id
		const seen = new Set<string>();
		const dedupedSymbols = processSymbols.filter((s) => {
			if (seen.has(s.id)) return false;
			seen.add(s.id);
			return true;
		});
		timer.stop(); // formatting

		// End-to-end wall time — deliberately a separate mark so callers can
		// compare sum(phases) vs wall to see how much Promise.all concurrency
		// saved. Must come before summary() so it's included.
		timer.mark("wall", performance.now() - wallStart);
		const timing = timer.summary();
		logQueryTiming(searchQuery, timing);

		return {
			processes,
			process_symbols: dedupedSymbols,
			definitions: definitions.slice(0, 20), // cap standalone definitions
			timing,
			...(!ftsUsed && {
				warning:
					"FTS indexes missing — keyword search degraded. Run: gitnexus analyze --force to rebuild indexes.",
			}),
		};
	}

	/**
	 * BM25 keyword search helper - uses LadybugDB FTS for always-fresh results
	 */
	protected async bm25Search(
		repo: RepoHandle,
		query: string,
		limit: number,
	): Promise<{ results: any[]; ftsUsed: boolean }> {
		let searchFTSFromLbug;
		try {
			({ searchFTSFromLbug } = await import("../../../core/search/bm25-index.js"));
		} catch (err: any) {
			// Module import can fail in sandboxed MCP contexts (#1489)
			logger.warn(
				{ err: err?.message },
				"GitNexus: bm25-index.js import failed — falling back to semantic-only",
			);
			return { results: [], ftsUsed: false };
		}
		let ftsResponse;
		try {
			ftsResponse = await searchFTSFromLbug(query, limit, repo.id);
		} catch (err: any) {
			logger.error(
				{ err: err.message },
				"GitNexus: BM25/FTS search failed (FTS indexes may not exist) -",
			);
			return { results: [], ftsUsed: false };
		}

		// Guard against unexpected response shape (#1489) — ftsResponse.results
		// could be undefined when the FTS extension is unavailable in the MCP process.
		const bm25Results = ftsResponse?.results ?? [];
		const ftsUsed = ftsResponse?.ftsAvailable ?? false;

		const results: any[] = [];

		for (const bm25Result of bm25Results) {
			const fullPath = bm25Result.filePath;
			try {
				// Prefer direct nodeId lookup (exact FTS-matched nodes) over filePath fallback.
				// Without this, LIMIT 3 on filePath returns arbitrary symbols rather than
				// the nodes that actually scored highest in the BM25 index.
				const nodeIds = bm25Result.nodeIds?.length ? bm25Result.nodeIds : null;
				const symbols = nodeIds
					? await executeParameterized(
							repo.id,
							`
              MATCH (n)
              WHERE n.id IN $nodeIds
              RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
            `,
							{ nodeIds },
						)
					: await executeParameterized(
							repo.id,
							`
              MATCH (n)
              WHERE n.filePath = $filePath
              RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
              LIMIT 3
            `,
							{ filePath: fullPath },
						);

				if (symbols.length > 0) {
					for (const sym of symbols) {
						results.push({
							nodeId: sym.id || sym[0],
							name: sym.name || sym[1],
							type: sym.type || sym[2],
							filePath: sym.filePath || sym[3],
							startLine: sym.startLine || sym[4],
							endLine: sym.endLine || sym[5],
							bm25Score: bm25Result.score,
						});
					}
				} else {
					const fileName = fullPath.split("/").pop() || fullPath;
					results.push({
						name: fileName,
						type: "File",
						filePath: bm25Result.filePath,
						bm25Score: bm25Result.score,
					});
				}
			} catch {
				const fileName = fullPath.split("/").pop() || fullPath;
				results.push({
					name: fileName,
					type: "File",
					filePath: bm25Result.filePath,
					bm25Score: bm25Result.score,
				});
			}
		}

		return { results, ftsUsed };
	}

	/**
	 * Semantic vector search helper
	 */
	protected async semanticSearch(
		repo: RepoHandle,
		query: string,
		limit: number,
	): Promise<any[]> {
		try {
			// Check if embedding table exists before loading the model (avoids heavy model init when embeddings are off)
			const tableCheck = await executeQuery(
				repo.id,
				`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN COUNT(*) AS cnt LIMIT 1`,
			);
			if (!tableCheck.length || (tableCheck[0].cnt ?? tableCheck[0][0]) === 0)
				return [];

			const { embedQuery, getEmbeddingDims } = await import("../../core/embedder.js");
			const queryVec = await embedQuery(query);
			const dims = getEmbeddingDims();
			const queryVecStr = `[${queryVec.join(",")}]`;

			let bestChunks = new Map<
				string,
				{ distance: number; chunkIndex: number; startLine: number; endLine: number }
			>();
			if (isVectorExtensionSupportedByPlatform()) {
				try {
					bestChunks = await collectBestChunks(limit, async (fetchLimit) => {
						const vectorQuery = `
            CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
              CAST(${queryVecStr} AS FLOAT[${dims}]), ${fetchLimit})
            YIELD node AS emb, distance
            WITH emb, distance
            WHERE distance < 0.6
            RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex,
                   emb.startLine AS startLine, emb.endLine AS endLine, distance
            ORDER BY distance
          `;

						const embResults = await executeQuery(repo.id, vectorQuery);
						return embResults.map((row) => ({
							nodeId: row.nodeId ?? row[0],
							chunkIndex: row.chunkIndex ?? row[1] ?? 0,
							startLine: row.startLine ?? row[2] ?? 0,
							endLine: row.endLine ?? row[3] ?? 0,
							distance: row.distance ?? row[4],
						}));
					});
				} catch {
					bestChunks = new Map();
				}
			} else if (!this.warnedVectorUnsupported) {
				// Rare diagnostic: surface why we fell back to the exact scan path so
				// operators can see at a glance that VECTOR is disabled by platform
				// policy. Emitted once per `LocalBackend` instance lifetime to avoid
				// noisy stderr on hot semantic-search paths (DoD §2.8).
				this.warnedVectorUnsupported = true;
				logger.warn(
					"GitNexus [query:vector]: VECTOR extension not supported on this platform; using exact scan fallback",
				);
			}

			if (bestChunks.size === 0) {
				const embeddingCount = Number(tableCheck[0].cnt ?? tableCheck[0][0] ?? 0);
				const exactLimit = getExactScanLimit();
				if (embeddingCount > exactLimit) return [];

				const rows = await executeQuery(
					repo.id,
					`
          MATCH (e:${EMBEDDING_TABLE_NAME})
          RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex,
                 e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding
        `,
				);
				const exactRows: ExactEmbeddingRow[] = rows.map((row) => ({
					nodeId: row.nodeId ?? row[0],
					chunkIndex: row.chunkIndex ?? row[1] ?? 0,
					startLine: row.startLine ?? row[2] ?? 0,
					endLine: row.endLine ?? row[3] ?? 0,
					embedding: row.embedding ?? row[4] ?? [],
				}));
				bestChunks = new Map(
					rankExactEmbeddingRows(exactRows, queryVec, limit, 0.6).map((row) => [
						row.nodeId,
						{
							distance: row.distance,
							chunkIndex: row.chunkIndex,
							startLine: row.startLine,
							endLine: row.endLine,
						},
					]),
				);
			}

			if (bestChunks.size === 0) return [];

			const results: any[] = [];

			for (const [nodeId, chunk] of Array.from(bestChunks.entries()).slice(
				0,
				limit,
			)) {
				const labelEndIdx = nodeId.indexOf(":");
				const label =
					labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : "Unknown";

				// Validate label against known node types to prevent Cypher injection
				if (!VALID_NODE_LABELS.has(label)) continue;

				try {
					const nodeQuery =
						label === "File"
							? `MATCH (n:File {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`
							: `MATCH (n:\`${label}\` {id: $nodeId}) RETURN n.name AS name, n.filePath AS filePath`;

					const nodeRows = await executeParameterized(repo.id, nodeQuery, {
						nodeId,
					});
					if (nodeRows.length > 0) {
						const nodeRow = nodeRows[0];
						results.push({
							nodeId,
							name: nodeRow.name ?? nodeRow[0] ?? "",
							type: label,
							filePath: nodeRow.filePath ?? nodeRow[1] ?? "",
							distance: chunk.distance,
							startLine: chunk.startLine,
							endLine: chunk.endLine,
						});
					}
				} catch {}
			}

			return results;
		} catch {
			// Expected when embeddings are disabled — silently fall back to BM25-only
			return [];
		}
	}

}
