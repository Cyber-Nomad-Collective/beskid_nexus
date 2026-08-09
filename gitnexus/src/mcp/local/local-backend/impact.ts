import { ChangesBackend } from "./changes.js";
import {
	type RepoHandle,
	VALID_RELATION_TYPES,
	confidenceForRelType,
	isTestFilePath,
	logQueryError,
} from "./formatting-errors.js";
import path from "node:path";
import {
	isWalCorruptionError,
	WAL_RECOVERY_SUGGESTION,
} from "../../../core/lbug/lbug-config.js";
import {
	executeParameterized,
	executeQuery,
} from "../../../core/lbug/pool-adapter.js";

export class ImpactBackend extends ChangesBackend {
	protected async impact(
		repo: RepoHandle,
		params: {
			target: string;
			target_uid?: string;
			file_path?: string;
			kind?: string;
			direction: "upstream" | "downstream";
			maxDepth?: number;
			relationTypes?: string[];
			includeTests?: boolean;
			minConfidence?: number;
		},
	): Promise<any> {
		try {
			return await this._impactImpl(repo, params);
		} catch (err: any) {
			// Return structured error instead of crashing (#321)
			return {
				error:
					(err instanceof Error ? err.message : String(err)) ||
					"Impact analysis failed",
				target: { name: params.target },
				direction: params.direction,
				impactedCount: 0,
				risk: "UNKNOWN",
				suggestion:
					"The graph query failed — try gitnexus context <symbol> as a fallback",
				...(isWalCorruptionError(err)
					? { recoverySuggestion: WAL_RECOVERY_SUGGESTION }
					: {}),
			};
		}
	}

	protected async _impactImpl(
		repo: RepoHandle,
		params: {
			target: string;
			target_uid?: string;
			file_path?: string;
			kind?: string;
			direction: "upstream" | "downstream";
			maxDepth?: number;
			relationTypes?: string[];
			includeTests?: boolean;
			minConfidence?: number;
		},
	): Promise<any> {
		await this.ensureInitialized(repo.id);

		const { target, direction } = params;
		const maxDepth = params.maxDepth || 3;
		// Map legacy relation type names before filtering (backward compat for OVERRIDES → METHOD_OVERRIDES)
		const mappedRelTypes = params.relationTypes?.flatMap((t: string) =>
			t === "OVERRIDES" ? ["OVERRIDES", "METHOD_OVERRIDES"] : [t],
		);
		const hasExplicitRelationTypes =
			mappedRelTypes !== undefined && mappedRelTypes.length > 0;
		const rawRelTypes =
			mappedRelTypes && mappedRelTypes.length > 0
				? mappedRelTypes.filter((t: string) => VALID_RELATION_TYPES.has(t))
				: [
						"CALLS",
						"IMPORTS",
						"EXTENDS",
						"IMPLEMENTS",
						"USES",
						"METHOD_OVERRIDES",
						"OVERRIDES",
						"METHOD_IMPLEMENTS",
					];
		const relationTypes =
			rawRelTypes.length > 0
				? rawRelTypes
				: [
						"CALLS",
						"IMPORTS",
						"EXTENDS",
						"IMPLEMENTS",
						"USES",
						"METHOD_OVERRIDES",
						"OVERRIDES",
						"METHOD_IMPLEMENTS",
					];
		const includeTests = params.includeTests ?? false;
		const minConfidence = params.minConfidence ?? 0;

		// Resolve target via the shared symbol resolver. When the caller passes
		// target_uid we skip the name lookup entirely (zero-ambiguity). Otherwise
		// we rank candidates (#470) and either proceed with a confident single
		// match, or return a structured ambiguous response instead of silently
		// picking the wrong symbol.
		//
		// The resolver preserves the #480 Class/Constructor preference heuristic:
		// when a Class and its Constructor share name + filePath, the Class is
		// selected silently.
		const outcome = await this.resolveSymbolCandidates(
			repo,
			{ uid: params.target_uid, name: target },
			{ file_path: params.file_path, kind: params.kind },
		);

		if (outcome.kind === "not_found") {
			const missing = params.target_uid ?? target;
			return {
				error: `Target '${missing}' not found`,
				target: { name: target },
				direction,
				impactedCount: 0,
				risk: "UNKNOWN",
			};
		}

		if (outcome.kind === "ambiguous") {
			return {
				status: "ambiguous",
				message: `Found ${outcome.candidates.length} symbols matching '${target}'. Use target_uid, file_path, or kind to disambiguate.`,
				target: { name: target },
				direction,
				impactedCount: 0,
				risk: "UNKNOWN",
				candidates: outcome.candidates.map((c) => ({
					uid: c.id,
					name: c.name,
					kind: c.type,
					filePath: c.filePath,
					line: c.startLine,
					score: Number(c.score.toFixed(2)),
				})),
			};
		}

		const sym = {
			id: outcome.symbol.id,
			name: outcome.symbol.name,
			filePath: outcome.symbol.filePath,
		};
		const symType = outcome.resolvedLabel || outcome.symbol.type || "";

		const effectiveRelationTypes =
			(symType === "Class" || symType === "Interface") &&
			!hasExplicitRelationTypes &&
			!relationTypes.includes("ACCESSES")
				? [...relationTypes, "ACCESSES"]
				: relationTypes;

		return this._runImpactBFS(repo, sym, symType, direction, {
			maxDepth,
			relationTypes: effectiveRelationTypes,
			includeTests,
			minConfidence,
		});
	}

	/**
	 * Shared BFS traversal for impact analysis (name-resolved or UID-resolved symbol).
	 */
	protected async _runImpactBFS(
		repo: RepoHandle,
		sym: any,
		symType: string,
		direction: "upstream" | "downstream",
		opts: {
			maxDepth: number;
			relationTypes: string[];
			includeTests: boolean;
			minConfidence: number;
		},
	): Promise<any> {
		const { maxDepth, relationTypes, includeTests, minConfidence } = opts;
		const relTypeFilter = relationTypes.map((t) => `'${t}'`).join(", ");
		const confidenceFilter =
			minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : "";

		const symId = sym.id || sym[0];

		const impacted: any[] = [];
		const visited = new Set<string>([symId]);
		let frontier = [symId];
		let traversalComplete = true;

		// Fix #480: For Java (and other JVM) Class/Interface nodes, CALLS edges
		// point to Constructor nodes and IMPORTS edges point to File nodes — not
		// the Class/Interface itself. Seed the frontier with the Constructor(s)
		// and owning File so the BFS traversal finds those edges naturally.
		// The owning File is kept only as an internal seed (frontier/visited) and
		// is NOT added to impacted — it is the definition container, not an
		// upstream dependent. The BFS will discover IMPORTS edges on it naturally.
		if (symType === "Class" || symType === "Interface") {
			try {
				// Run both seed queries in parallel — they are independent.
				const [ctorRows, fileRows] = await Promise.all([
					executeParameterized(
						repo.id,
						`
            MATCH (n)-[hm:CodeRelation]->(c:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            RETURN c.id AS id, c.name AS name, labels(c)[0] AS type, c.filePath AS filePath
          `,
						{ symId },
					),
					// Restrict to DEFINES edges only — other File->Class edge types (if
					// any) should not be treated as the owning file relationship.
					executeParameterized(
						repo.id,
						`
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            RETURN f.id AS id, f.name AS name, labels(f)[0] AS type, f.filePath AS filePath
          `,
						{ symId },
					),
				]);

				for (const r of ctorRows) {
					const rid = r.id || r[0];
					if (rid && !visited.has(rid)) {
						visited.add(rid);
						frontier.push(rid);
					}
				}
				for (const r of fileRows) {
					const rid = r.id || r[0];
					if (rid && !visited.has(rid)) {
						visited.add(rid);
						frontier.push(rid);
					}
				}

				const typedPropertyRows = await executeParameterized(
					repo.id,
					`
          MATCH (p:\`Property\`)
          WHERE p.declaredType = $name
             OR p.declaredType STARTS WITH $genericPrefix
             OR p.declaredType CONTAINS $genericArg
          RETURN p.id AS id, p.name AS name, labels(p)[0] AS type, p.filePath AS filePath
        `,
					{
						name: sym.name,
						genericPrefix: `${sym.name}<`,
						genericArg: `<${sym.name}>`,
					},
				);

				for (const r of typedPropertyRows) {
					const rid = r.id || r[0];
					if (rid && !visited.has(rid)) {
						visited.add(rid);
						frontier.push(rid);
					}
				}
			} catch (e) {
				logQueryError("impact:class-node-expansion", e);
			}
		}

		for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
			const nextFrontier: string[] = [];

			// Batch frontier nodes into a single Cypher query per depth level
			const idList = frontier
				.map((id) => `'${id.replace(/'/g, "''")}'`)
				.join(", ");
			const query =
				direction === "upstream"
					? `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller)[0] AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence`
					: `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee)[0] AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence`;

			try {
				const related = await executeQuery(repo.id, query);

				for (const rel of related) {
					const relId = rel.id || rel[1];
					const filePath = rel.filePath || rel[4] || "";

					if (!includeTests && isTestFilePath(filePath)) continue;

					if (!visited.has(relId)) {
						visited.add(relId);
						nextFrontier.push(relId);
						const storedConfidence = rel.confidence ?? rel[6];
						const relationType = rel.relType || rel[5];
						// Prefer the stored confidence from the graph (set at analysis time);
						// fall back to the per-type floor for edges without a stored value.
						const effectiveConfidence =
							typeof storedConfidence === "number" && storedConfidence > 0
								? storedConfidence
								: confidenceForRelType(relationType);
						impacted.push({
							depth,
							id: relId,
							name: rel.name || rel[2],
							type: rel.type || rel[3],
							filePath,
							relationType,
							confidence: effectiveConfidence,
						});
					}
				}
			} catch (e) {
				logQueryError("impact:depth-traversal", e);
				// Break out of depth loop on query failure but return partial results
				// collected so far, rather than silently swallowing the error (#321)
				traversalComplete = false;
				break;
			}

			frontier = nextFrontier;
		}

		const grouped: Record<number, any[]> = {};
		for (const item of impacted) {
			if (!grouped[item.depth]) grouped[item.depth] = [];
			grouped[item.depth].push(item);
		}

		// ── Enrichment: affected processes, modules, risk ──────────────
		const directCount = (grouped[1] || []).length;
		let affectedProcesses: any[] = [];
		let affectedModules: any[] = [];

		if (impacted.length > 0) {
			const CHUNK_SIZE = 100;
			// Max number of chunks to process to avoid unbounded DB round-trips.
			// Configurable via env IMPACT_MAX_CHUNKS, default 10 => max items = 1000
			const MAX_CHUNKS = parseInt(process.env.IMPACT_MAX_CHUNKS || "10", 10);

			// ── Process enrichment: batched chunking (bounded by MAX_CHUNKS) ─
			// Uses merged Cypher query (WITH + OPTIONAL MATCH) to fetch
			// process + entry point info in 1 round-trip per chunk. Converted to
			// parameterized queries to avoid manual string escaping and long query strings.
			const entryPointMap = new Map<
				string,
				{
					name: string;
					type: string;
					filePath: string;
					affected_process_count: number;
					total_hits: number;
					earliest_broken_step: number;
				}
			>();

			// Map process id -> entryPointId to allow fixing missing minStep values later
			const processToEntryPoint = new Map<string, string>();
			// Collect process ids where MIN(r.step) returned null so we can retry in batch
			const processesMissingMinStep = new Set<string>();

			let chunksProcessed = 0;
			for (
				let i = 0;
				i < impacted.length && chunksProcessed < MAX_CHUNKS;
				i += CHUNK_SIZE, chunksProcessed++
			) {
				const chunk = impacted.slice(i, i + CHUNK_SIZE);
				const ids = chunk.map((item) => String(item.id ?? ""));

				try {
					// Use parameterized list to avoid building long query strings
					const rows = await executeParameterized(
						repo.id,
						`
            MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
            WHERE s.id IN $ids
            WITH p, COUNT(DISTINCT s.id) AS hits, MIN(r.step) AS minStep
            OPTIONAL MATCH (ep {id: p.entryPointId})
            RETURN p.id AS pId, p.heuristicLabel AS name, p.processType AS processType,
                   p.entryPointId AS entryPointId, hits, minStep, p.stepCount AS stepCount,
                   ep.name AS epName, labels(ep)[0] AS epType, ep.filePath AS epFilePath
          `,
						{ ids },
					).catch(() => []);

					for (const row of rows) {
						const pId = row.pId ?? row[0];
						const epId = row.entryPointId ?? row[3] ?? row.pId ?? row[0];
						// Track mapping from process -> entryPoint so we can backfill missing minStep
						if (pId) processToEntryPoint.set(String(pId), String(epId));

						// Normalize epName: prefer epName, fall back to other columns, and
						// ensure we don't keep an empty string (labels(...) can return "").
						const epNameRaw = row.epName ?? row[7] ?? row.name ?? row[1] ?? "unknown";
						const epName =
							typeof epNameRaw === "string" && epNameRaw.trim().length > 0
								? epNameRaw.trim()
								: "unknown";

						// Normalize epType: labels(ep)[0] can return an empty string in
						// some DBs (LadybugDB). Using nullish coalescing (??) preserves
						// empty strings, which results in empty `type` values being
						// propagated. Treat empty-string labels as missing and fall back
						// to the next candidate or a sensible default.
						const epTypeRaw = row.epType ?? row[8] ?? "";
						const epType =
							typeof epTypeRaw === "string" && epTypeRaw.trim().length > 0
								? epTypeRaw.trim()
								: "Function";

						const epFilePath = row.epFilePath ?? row[9] ?? "";
						const hits = row.hits ?? row[4] ?? 0;
						const minStep = row.minStep ?? row[5];
						// If the DB returned null for minStep, note the process id so we
						// can run a follow-up query using a different aggregation strategy.
						if (minStep === null || minStep === undefined) {
							if (pId) processesMissingMinStep.add(String(pId));
						}
						if (!entryPointMap.has(epId)) {
							entryPointMap.set(epId, {
								name: epName,
								type: epType,
								filePath: epFilePath,
								affected_process_count: 0,
								total_hits: 0,
								earliest_broken_step: Infinity,
							});
						}
						const ep = entryPointMap.get(epId)!;
						ep.affected_process_count += 1;
						ep.total_hits += hits;
						ep.earliest_broken_step = Math.min(
							ep.earliest_broken_step,
							minStep ?? Infinity,
						);
					}
				} catch (e) {
					logQueryError("impact:process-chunk", e);
				}
			}

			// If some processes returned null minStep, try a batched follow-up query
			// using the full impacted id set. This handles older indexes or DBs
			// where MIN(r.step) can come back null even when step properties exist.
			if (processesMissingMinStep.size > 0) {
				try {
					const pIds = Array.from(processesMissingMinStep);
					const allImpactedIds = impacted.map((it) => String(it.id ?? ""));
					const missingRows = await executeParameterized(
						repo.id,
						`
            MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
            WHERE p.id IN $pIds AND s.id IN $ids
            RETURN p.id AS pid, MIN(r.step) AS minStep
          `,
						{ pIds, ids: allImpactedIds },
					).catch(() => []);

					for (const mr of missingRows) {
						const pid = mr.pid ?? mr[0];
						const minStep = mr.minStep ?? mr[1];
						const epId = processToEntryPoint.get(String(pid));
						if (!epId) continue;
						const ep = entryPointMap.get(epId);
						if (!ep) continue;
						if (typeof minStep === "number") {
							ep.earliest_broken_step = Math.min(ep.earliest_broken_step, minStep);
						}
					}
				} catch (e) {
					logQueryError("impact:process-chunk-backfill", e);
				}
			}

			// If we capped chunks, mark traversal incomplete so caller knows results are partial
			if (chunksProcessed * CHUNK_SIZE < impacted.length) {
				traversalComplete = false;
			}

			affectedProcesses = Array.from(entryPointMap.values())
				.map((ep) => ({
					...ep,
					earliest_broken_step:
						ep.earliest_broken_step === Infinity ? null : ep.earliest_broken_step,
				}))
				.sort((a, b) => b.total_hits - a.total_hits);

			// ── Module enrichment: use same cap as process enrichment and parameterized queries
			const maxItems = Math.min(impacted.length, MAX_CHUNKS * CHUNK_SIZE);
			const cappedImpacted = impacted.slice(0, maxItems);
			const allIdsArr = cappedImpacted.map((i: any) => String(i.id ?? ""));
			const d1Items = (grouped[1] || []).slice(0, maxItems);
			const d1IdsArr = d1Items.map((i: any) => String(i.id ?? ""));

			// Chunked module enrichment: run the MEMBER_OF queries in chunks
			// to avoid large single queries or concurrent Kuzu calls that can
			// crash (SIGSEGV) on arm64 macOS; behavior preserves existing maxItems cap and returns equivalent aggregated results.
			const moduleHitsMap = new Map<string, number>();
			const directModuleSet = new Set<string>();

			// Helper to run a single module chunk and accumulate hits by name
			const runModuleChunk = async (idsChunk: string[]) => {
				if (!idsChunk || idsChunk.length === 0) return;
				try {
					const rows = await executeParameterized(
						repo.id,
						`
            MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
            WHERE s.id IN $ids
            RETURN c.heuristicLabel AS name, COUNT(DISTINCT s.id) AS hits
            ORDER BY hits DESC
            LIMIT 20
          `,
						{ ids: idsChunk },
					).catch(() => []);

					for (const r of rows) {
						const name = r.name ?? r[0] ?? null;
						const hits = (r.hits ?? r[1]) || 0;
						if (!name) continue;
						moduleHitsMap.set(name, (moduleHitsMap.get(name) || 0) + hits);
					}
				} catch (e) {
					logQueryError("impact:module-chunk", e);
				}
			};

			// Run module query chunks sequentially (safe on arm64 macOS)
			for (let i = 0; i < allIdsArr.length; i += CHUNK_SIZE) {
				const chunkIds = allIdsArr.slice(i, i + CHUNK_SIZE);
				await runModuleChunk(chunkIds);
			}

			// Run direct module query similarly (distinct heuristic labels for depth-1 items)
			const runDirectModuleChunk = async (idsChunk: string[]) => {
				if (!idsChunk || idsChunk.length === 0) return;
				try {
					const rows = await executeParameterized(
						repo.id,
						`
            MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
            WHERE s.id IN $ids
            RETURN DISTINCT c.heuristicLabel AS name
          `,
						{ ids: idsChunk },
					).catch(() => []);
					for (const r of rows) {
						const name = r.name ?? r[0] ?? null;
						if (name) directModuleSet.add(name);
					}
				} catch (e) {
					logQueryError("impact:direct-module-chunk", e);
				}
			};

			for (let i = 0; i < d1IdsArr.length; i += CHUNK_SIZE) {
				const chunkIds = d1IdsArr.slice(i, i + CHUNK_SIZE);
				await runDirectModuleChunk(chunkIds);
			}

			// Build final moduleRows array from aggregated hits map, sorted & limited
			const moduleRows = Array.from(moduleHitsMap.entries())
				.map(([name, hits]) => ({ name, hits }))
				.sort((a, b) => b.hits - a.hits)
				.slice(0, 20);

			const directModuleRows = Array.from(directModuleSet).map((name) => ({
				name,
			}));

			// Build affectedModules in the same shape as original implementation
			const directModuleNameSet = new Set(
				directModuleRows.map((r: any) => r.name || r[0]),
			);
			affectedModules = moduleRows.map((r: any) => {
				const name = r.name ?? r[0];
				const hits = r.hits ?? r[1] ?? 0;
				return {
					name,
					hits,
					impact: directModuleNameSet.has(name) ? "direct" : "indirect",
				};
			});
		}

		// Risk scoring
		const processCount = affectedProcesses.length;
		const moduleCount = affectedModules.length;
		let risk = "LOW";
		if (
			directCount >= 30 ||
			processCount >= 5 ||
			moduleCount >= 5 ||
			impacted.length >= 200
		) {
			risk = "CRITICAL";
		} else if (
			directCount >= 15 ||
			processCount >= 3 ||
			moduleCount >= 3 ||
			impacted.length >= 100
		) {
			risk = "HIGH";
		} else if (directCount >= 5 || impacted.length >= 30) {
			risk = "MEDIUM";
		}

		return {
			target: {
				id: symId,
				name: sym.name || sym[1],
				type: symType,
				filePath: sym.filePath || sym[2],
			},
			direction,
			impactedCount: impacted.length,
			risk,
			...(!traversalComplete && { partial: true }),
			summary: {
				direct: directCount,
				processes_affected: processCount,
				modules_affected: moduleCount,
			},
			affected_processes: affectedProcesses,
			affected_modules: affectedModules,
			byDepth: grouped,
		};
	}

	/**
	 * UID-based impact for cross-repo fan-out. Same result shape as `impact`.
	 * Returns null if the repo is unknown, the UID is missing, or analysis fails.
	 */
	async impactByUid(
		repoId: string,
		uid: string,
		direction: string,
		opts: {
			maxDepth: number;
			relationTypes: string[];
			minConfidence: number;
			includeTests: boolean;
			signal?: AbortSignal;
		},
	): Promise<any | null> {
		// Honor an already-aborted signal at the entry boundary as a fast
		// path. Cooperative cancellation inside _runImpactBFS is out of
		// scope — the caller's Promise.race against the same signal
		// resolves the await regardless of how long this body runs.
		if (opts.signal?.aborted) return null;
		try {
			await this.refreshRepos();
			await this.ensureInitialized(repoId);
		} catch {
			return null;
		}

		const repo = this.repos.get(repoId);
		if (!repo) return null;

		const dir: "upstream" | "downstream" =
			direction === "downstream" ? "downstream" : "upstream";

		let rows: any[];
		try {
			rows = await executeParameterized(
				repoId,
				`MATCH (n) WHERE n.id = $uid
         RETURN n.id AS id, n.name AS name, n.filePath AS filePath, labels(n)[0] AS type
         LIMIT 1`,
				{ uid },
			);
		} catch {
			return null;
		}
		if (!rows?.length) return null;

		const sym = rows[0];
		const labelRaw = sym.type ?? sym[3];
		const symType =
			typeof labelRaw === "string" && labelRaw.trim().length > 0
				? labelRaw.trim()
				: "";

		// Map legacy relation type names (backward compat for OVERRIDES → METHOD_OVERRIDES)
		const mappedRelTypes = opts.relationTypes?.flatMap((t: string) =>
			t === "OVERRIDES" ? ["OVERRIDES", "METHOD_OVERRIDES"] : [t],
		);
		const rawRelTypes =
			mappedRelTypes && mappedRelTypes.length > 0
				? mappedRelTypes.filter((t: string) => VALID_RELATION_TYPES.has(t))
				: [
						"CALLS",
						"IMPORTS",
						"EXTENDS",
						"IMPLEMENTS",
						"METHOD_OVERRIDES",
						"OVERRIDES",
						"METHOD_IMPLEMENTS",
					];
		const relationTypes =
			rawRelTypes.length > 0
				? rawRelTypes
				: [
						"CALLS",
						"IMPORTS",
						"EXTENDS",
						"IMPLEMENTS",
						"METHOD_OVERRIDES",
						"OVERRIDES",
						"METHOD_IMPLEMENTS",
					];

		try {
			return await this._runImpactBFS(repo, sym, symType, dir, {
				maxDepth: opts.maxDepth,
				relationTypes,
				includeTests: opts.includeTests,
				minConfidence: opts.minConfidence,
			});
		} catch {
			return null;
		}
	}

}
