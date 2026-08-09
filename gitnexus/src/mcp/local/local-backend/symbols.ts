import { GraphBackend } from "./graph.js";
import { type RepoHandle, logQueryError } from "./formatting-errors.js";
import path from "node:path";
import {
	isWalCorruptionError,
	WAL_RECOVERY_SUGGESTION,
} from "../../../core/lbug/lbug-config.js";
import { executeParameterized } from "../../../core/lbug/pool-adapter.js";

export class SymbolsBackend extends GraphBackend {
	protected async enrichCandidateLabels(
		repo: RepoHandle,
		candidates: Array<{ id: string; type: string }>,
	): Promise<void> {
		const ids = candidates.filter((c) => c.type === "" && c.id).map((c) => c.id);
		if (ids.length === 0) return;
		try {
			const rows = await executeParameterized(
				repo.id,
				`
        MATCH (n:\`Class\`) WHERE n.id IN $ids RETURN n.id AS id, 'Class' AS label
        UNION ALL
        MATCH (n:\`Interface\`) WHERE n.id IN $ids RETURN n.id AS id, 'Interface' AS label
        UNION ALL
        MATCH (n:\`Function\`) WHERE n.id IN $ids RETURN n.id AS id, 'Function' AS label
        UNION ALL
        MATCH (n:\`Method\`) WHERE n.id IN $ids RETURN n.id AS id, 'Method' AS label
        UNION ALL
        MATCH (n:\`Constructor\`) WHERE n.id IN $ids RETURN n.id AS id, 'Constructor' AS label
        `,
				{ ids },
			);
			const labelById = new Map<string, string>();
			for (const r of rows as any[]) {
				const id = (r.id ?? r[0]) as string;
				const label = (r.label ?? r[1]) as string;
				if (id && label && !labelById.has(id)) labelById.set(id, label);
			}
			for (const c of candidates) {
				if (c.type === "" && labelById.has(c.id))
					c.type = labelById.get(c.id) as string;
			}
		} catch {
			/* best-effort — downstream resolvers still work without the label */
		}
	}

	/**
	 * Score a symbol candidate for disambiguation ranking.
	 *
	 * Deterministic, no DB round-trip:
	 *   - base 0.50
	 *   - +0.40 when file_path hint matches (substring, case-insensitive)
	 *   - +0.20 when kind hint exactly matches the candidate's kind
	 *   - when no kind hint, a small priority bonus (Class > Interface >
	 *     Function > Method > Constructor) to preserve the intuition that
	 *     class-level names are usually what the user wanted.
	 *
	 * Capped at 1.0. Intentionally simple and inspectable — a future v2 can
	 * plug in BM25/embedding signals here without changing the surrounding
	 * resolver shape.
	 */
	protected scoreCandidate(
		c: { kind: string; filePath: string },
		hints: { file_path?: string; kind?: string },
	): number {
		let s = 0.5;
		if (hints.file_path && c.filePath && typeof c.filePath === "string") {
			if (c.filePath.toLowerCase().includes(hints.file_path.toLowerCase())) {
				s += 0.4;
			}
		}
		if (hints.kind && c.kind === hints.kind) {
			s += 0.2;
		}
		if (!hints.kind) {
			const priority: Record<string, number> = {
				Class: 5,
				Interface: 4,
				Function: 3,
				Method: 2,
				Constructor: 1,
			};
			s += (priority[c.kind] ?? 0) * 0.02;
		}
		return Math.min(1.0, s);
	}

	/**
	 * Shared symbol resolver used by `context` and `impact`.
	 *
	 * Returns one of:
	 *   - `{ kind: 'ok', symbol, resolvedLabel }` — single confident match
	 *     (either direct UID, only one candidate after filtering, Class/
	 *     Constructor collapse, or a top-scoring candidate with a clear gap
	 *     to the runner-up).
	 *   - `{ kind: 'ambiguous', candidates }` — multiple viable matches,
	 *     sorted by score desc. Each candidate carries a relevance score.
	 *   - `{ kind: 'not_found' }` — no matches at all.
	 *
	 * Preserves the #480 Class/Constructor preference: when the only
	 * ambiguity is between a Class and its own Constructor (same name,
	 * same filePath), the Class wins silently.
	 */
	protected async resolveSymbolCandidates(
		repo: RepoHandle,
		query: { uid?: string; name?: string; include_content?: boolean },
		hints: { file_path?: string; kind?: string },
	): Promise<
		| {
				kind: "ok";
				symbol: {
					id: string;
					name: string;
					type: string;
					filePath: string;
					startLine: number;
					endLine: number;
					content?: string;
				};
				resolvedLabel: string;
		  }
		| {
				kind: "ambiguous";
				candidates: Array<{
					id: string;
					name: string;
					type: string;
					filePath: string;
					startLine: number;
					endLine: number;
					score: number;
				}>;
		  }
		| { kind: "not_found" }
	> {
		const { uid, name, include_content } = query;
		const selectClause = `n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ", n.content AS content" : ""}`;

		// Direct UID — zero-ambiguity path.
		if (uid) {
			const rows = await executeParameterized(
				repo.id,
				`MATCH (n {id: $uid}) RETURN ${selectClause} LIMIT 1`,
				{ uid },
			);
			if (rows.length === 0) return { kind: "not_found" };
			const r = rows[0] as any;
			const symbol = {
				id: (r.id ?? r[0]) as string,
				name: (r.name ?? r[1]) as string,
				type: (r.type ?? r[2] ?? "") as string,
				filePath: (r.filePath ?? r[3]) as string,
				startLine: (r.startLine ?? r[4]) as number,
				endLine: (r.endLine ?? r[5]) as number,
				...(include_content
					? { content: (r.content ?? r[6]) as string | undefined }
					: {}),
			};
			// Same LadybugDB label-enrichment as the name-based path: a UID
			// pointing at a Class must still surface `type: 'Class'` so impact's
			// Class/Interface BFS seed fires. No-op when type is already set.
			await this.enrichCandidateLabels(repo, [symbol]);
			return { kind: "ok", symbol, resolvedLabel: symbol.type };
		}

		if (!name) return { kind: "not_found" };

		const isQualified = name.includes("/") || name.includes(":");
		let whereClause: string;
		const queryParams: Record<string, any> = { symName: name };
		if (hints.file_path) {
			whereClause = `WHERE n.name = $symName AND n.filePath CONTAINS $filePath`;
			queryParams.filePath = hints.file_path;
		} else if (isQualified) {
			whereClause = `WHERE n.id = $symName OR n.name = $symName`;
		} else {
			whereClause = `WHERE n.name = $symName`;
		}

		// LIMIT 20 (was 10) — scoring is the point now, so give the ranker
		// headroom instead of arbitrary truncation.
		const rows = await executeParameterized(
			repo.id,
			`MATCH (n) ${whereClause} RETURN ${selectClause} LIMIT 20`,
			queryParams,
		);

		if (rows.length === 0) return { kind: "not_found" };

		// Normalise row shape across object / tuple returns from LadybugDB.
		const normalized = rows.map((r: any) => ({
			id: (r.id ?? r[0]) as string,
			name: (r.name ?? r[1]) as string,
			type: (r.type ?? r[2] ?? "") as string,
			filePath: (r.filePath ?? r[3]) as string,
			startLine: (r.startLine ?? r[4]) as number,
			endLine: (r.endLine ?? r[5]) as number,
			...(include_content
				? { content: (r.content ?? r[6]) as string | undefined }
				: {}),
		}));

		// Enrich labels for any candidates where `labels(n)[0]` came back empty.
		// LadybugDB returns an empty string for that projection on certain node
		// types (notably Class), which left downstream consumers (impact's
		// Class/Interface BFS seed, the kind-priority scoring bonus) unable to
		// distinguish a Class target from "unknown kind". One scoped UNION
		// across the five priority labels patches the type in-place without
		// per-candidate round-trips.
		await this.enrichCandidateLabels(repo, normalized);

		// Preserve #480 Class/Constructor collapse: if we have exactly one
		// Class (or Interface) candidate and one Constructor sharing name +
		// filePath, fold into the Class. This used to require a follow-up
		// label query because LadybugDB sometimes returns an empty labels()[0]
		// for Class nodes — enrichment above handles the empty-type case, but
		// the `type === 'Constructor'` gate still correctly triggers when a
		// Class and its Constructor share the name.
		if (!hints.kind && normalized.length > 1) {
			const ambiguousType = normalized.some(
				(s) => s.type === "" || s.type === "Constructor",
			);
			if (ambiguousType) {
				const candidateIds = normalized.map((s) => s.id).filter(Boolean);
				for (const label of ["Class", "Interface"]) {
					const labelRows = await executeParameterized(
						repo.id,
						`MATCH (n:\`${label}\`) WHERE n.id IN $candidateIds RETURN n.id AS id LIMIT 1`,
						{ candidateIds },
					).catch(() => []);
					if (labelRows.length > 0) {
						const preferredId = (labelRows[0] as any).id ?? (labelRows[0] as any)[0];
						const preferred = normalized.find((s) => s.id === preferredId);
						if (preferred) {
							return {
								kind: "ok",
								symbol: preferred,
								resolvedLabel: label,
							};
						}
					}
				}
			}
		}

		if (normalized.length === 1) {
			return {
				kind: "ok",
				symbol: normalized[0],
				resolvedLabel: "",
			};
		}

		// Score, sort desc, stable tiebreak on shorter filePath then lex uid.
		const scored = normalized.map((s) => ({
			...s,
			score: this.scoreCandidate(
				{ kind: s.type, filePath: s.filePath || "" },
				hints,
			),
		}));
		scored.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const fpA = (a.filePath || "").length;
			const fpB = (b.filePath || "").length;
			if (fpA !== fpB) return fpA - fpB;
			return String(a.id).localeCompare(String(b.id));
		});

		// Confident single-result: top score ≥ 0.95 AND beats runner-up by a
		// clear margin. This lets a very strong file_path/kind hint resolve
		// cleanly instead of forcing the caller through a disambiguation
		// round-trip.
		//
		// The gap threshold uses `> 0.09` rather than `>= 0.10` on purpose:
		// IEEE754 addition of the scoring terms (0.50 + 0.40 + 0.20 - 0.90
		// yields 0.09999999999999998, not exactly 0.10) would otherwise break
		// the comparison for legitimate "top is 1.00, runner is 0.90" cases.
		// The intent is a clearly-dominant winner; 0.09 is a large enough
		// margin to mean that unambiguously.
		//
		// The `scored.length >= 2` guard is defensive. The `normalized.length === 1`
		// early return above already handles the single-candidate path, so in
		// practice `scored` always has at least two elements by the time we get
		// here — keeping the guard means changes to the upstream early-return
		// logic cannot accidentally index out of bounds at `scored[1]`.
		if (
			scored.length >= 2 &&
			scored[0].score >= 0.95 &&
			scored[0].score - scored[1].score > 0.09
		) {
			return { kind: "ok", symbol: scored[0], resolvedLabel: scored[0].type };
		}

		return { kind: "ambiguous", candidates: scored };
	}

	/**
	 * Context tool — 360-degree symbol view with categorized refs.
	 * Disambiguation (ranked) when multiple symbols share a name.
	 * UID-based direct lookup. No cluster in output.
	 */
	protected async context(
		repo: RepoHandle,
		params: {
			name?: string;
			uid?: string;
			file_path?: string;
			kind?: string;
			include_content?: boolean;
		},
	): Promise<any> {
		try {
			return await this._contextImpl(repo, params);
		} catch (err: any) {
			const msg =
				(err instanceof Error ? err.message : String(err)) ||
				"Context query failed";
			if (isWalCorruptionError(err)) {
				return {
					error: msg,
					recoverySuggestion: WAL_RECOVERY_SUGGESTION,
				};
			}
			throw err;
		}
	}

	protected async _contextImpl(
		repo: RepoHandle,
		params: {
			name?: string;
			uid?: string;
			file_path?: string;
			kind?: string;
			include_content?: boolean;
		},
	): Promise<any> {
		await this.ensureInitialized(repo.id);

		const { name, uid, file_path, kind, include_content } = params;

		if (!name && !uid) {
			return { error: 'Either "name" or "uid" parameter is required.' };
		}

		const outcome = await this.resolveSymbolCandidates(
			repo,
			{ uid, name, include_content },
			{ file_path, kind },
		);

		if (outcome.kind === "not_found") {
			return { error: `Symbol '${name || uid}' not found` };
		}

		if (outcome.kind === "ambiguous") {
			return {
				status: "ambiguous",
				message: `Found ${outcome.candidates.length} symbols matching '${name}'. Use uid, file_path, or kind to disambiguate.`,
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

		// Step 3: Build full context
		const sym = outcome.symbol;
		const resolvedLabel = outcome.resolvedLabel;
		const symId = sym.id;

		// Categorized incoming refs
		const incomingRows = await executeParameterized(
			repo.id,
			`
      MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
      RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
      LIMIT 30
    `,
			{ symId },
		);
		let typedPropertyRows: any[] = [];

		// Fix #480: Class/Interface nodes have no direct CALLS/IMPORTS edges —
		// those point to Constructor and File nodes respectively. Fetch those
		// extra incoming refs and merge them in so context() shows real callers.
		//
		// Determine if this is a Class/Interface node. If resolvedLabel was set
		// during disambiguation (Step 2), use it directly — no extra round-trip.
		// Otherwise fall back to a single label check only when the type field is
		// empty (LadybugDB labels(n)[0] limitation).
		const symRawType = sym.type || sym[2] || "";
		let isClassLike = resolvedLabel === "Class" || resolvedLabel === "Interface";
		if (!isClassLike && symRawType === "") {
			try {
				// Single UNION query instead of two serial round-trips.
				const typeCheck = await executeParameterized(
					repo.id,
					`
          MATCH (n:Class) WHERE n.id = $symId RETURN 'Class' AS label LIMIT 1
          UNION ALL
          MATCH (n:Interface) WHERE n.id = $symId RETURN 'Interface' AS label LIMIT 1
        `,
					{ symId },
				);
				isClassLike = typeCheck.length > 0;
			} catch {
				/* not a Class/Interface node */
			}
		} else if (!isClassLike) {
			isClassLike = symRawType === "Class" || symRawType === "Interface";
		}

		if (isClassLike) {
			try {
				// Run incoming-ref queries in parallel — they are independent.
				const [ctorIncoming, fileIncoming, typedPropertyIncoming, typedProperties] =
					await Promise.all([
						executeParameterized(
							repo.id,
							`
            MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)
            WHERE n.id = $symId AND hm.type = 'HAS_METHOD'
            MATCH (caller)-[r:CodeRelation]->(ctor)
            WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'ACCESSES']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `,
							{ symId },
						),
						executeParameterized(
							repo.id,
							`
            MATCH (f:File)-[rel:CodeRelation]->(n)
            WHERE n.id = $symId AND rel.type = 'DEFINES'
            MATCH (caller)-[r:CodeRelation]->(f)
            WHERE r.type IN ['CALLS', 'IMPORTS']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `,
							{ symId },
						),
						executeParameterized(
							repo.id,
							`
            MATCH (p:\`Property\`)
            WHERE p.declaredType = $name
               OR p.declaredType STARTS WITH $genericPrefix
               OR p.declaredType CONTAINS $genericArg
            MATCH (caller)-[r:CodeRelation]->(p)
            WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'ACCESSES']
            RETURN r.type AS relType, caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller)[0] AS kind
            LIMIT 30
          `,
							{
								name: sym.name,
								genericPrefix: `${sym.name}<`,
								genericArg: `<${sym.name}>`,
							},
						),
						executeParameterized(
							repo.id,
							`
            MATCH (p:\`Property\`)
            WHERE p.declaredType = $name
               OR p.declaredType STARTS WITH $genericPrefix
               OR p.declaredType CONTAINS $genericArg
            RETURN p.id AS uid, p.name AS name, p.filePath AS filePath, labels(p)[0] AS kind,
                   p.declaredType AS declaredType
            LIMIT 30
          `,
							{
								name: sym.name,
								genericPrefix: `${sym.name}<`,
								genericArg: `<${sym.name}>`,
							},
						),
					]);
				typedPropertyRows = typedProperties;

				// Deduplicate by (relType, uid) — a caller can have multiple relation
				// types to the same target (e.g. both IMPORTS and CALLS), and each
				// must be preserved so every category appears in the output.
				const seenKeys = new Set(
					incomingRows.map((r: any) => `${r.relType || r[0]}:${r.uid || r[1]}`),
				);
				for (const r of [
					...ctorIncoming,
					...fileIncoming,
					...typedPropertyIncoming,
				]) {
					const key = `${r.relType || r[0]}:${r.uid || r[1]}`;
					if (!seenKeys.has(key)) {
						seenKeys.add(key);
						incomingRows.push(r);
					}
				}
			} catch (e) {
				logQueryError("context:class-incoming-expansion", e);
			}
		}

		// Categorized outgoing refs
		const outgoingRows = await executeParameterized(
			repo.id,
			`
      MATCH (n {id: $symId})-[r:CodeRelation]->(target)
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'HAS_METHOD', 'HAS_PROPERTY', 'METHOD_OVERRIDES', 'OVERRIDES', 'METHOD_IMPLEMENTS', 'ACCESSES']
      RETURN r.type AS relType, target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target)[0] AS kind
      LIMIT 30
    `,
			{ symId },
		);

		// Process participation
		let processRows: any[] = [];
		try {
			processRows = await executeParameterized(
				repo.id,
				`
        MATCH (n {id: $symId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      `,
				{ symId },
			);
		} catch (e) {
			logQueryError("context:process-participation", e);
		}

		// Helper to categorize refs
		const categorize = (rows: any[]) => {
			const cats: Record<string, any[]> = {};
			for (const row of rows) {
				const relType = (row.relType || row[0] || "").toLowerCase();
				const entry = {
					uid: row.uid || row[1],
					name: row.name || row[2],
					filePath: row.filePath || row[3],
					kind: row.kind || row[4],
				};
				if (!cats[relType]) cats[relType] = [];
				cats[relType].push(entry);
			}
			return cats;
		};

		// Method/Function/Constructor enrichment: fetch method-specific properties
		const symKind = isClassLike ? resolvedLabel || "Class" : sym.type || sym[2];
		const isMethodLike =
			symKind === "Method" || symKind === "Function" || symKind === "Constructor";
		let methodMetadata: Record<string, unknown> | undefined;
		if (isMethodLike) {
			try {
				const metaRows = await executeParameterized(
					repo.id,
					`
          MATCH (n {id: $symId})
          RETURN n.visibility AS visibility, n.isStatic AS isStatic, n.isAbstract AS isAbstract,
                 n.isFinal AS isFinal, n.isVirtual AS isVirtual, n.isOverride AS isOverride,
                 n.isAsync AS isAsync, n.isPartial AS isPartial, n.returnType AS returnType,
                 n.parameterCount AS parameterCount, n.isVariadic AS isVariadic,
                 n.requiredParameterCount AS requiredParameterCount,
                 n.parameterTypes AS parameterTypes, n.annotations AS annotations
          LIMIT 1
        `,
					{ symId },
				);
				if (metaRows.length > 0) {
					const row = metaRows[0];
					const meta: Record<string, unknown> = {};
					// Only include defined properties to distinguish "not applicable" from "not enriched"
					for (const key of Object.keys(row)) {
						const val = row[key];
						if (val !== null && val !== undefined) meta[key] = val;
					}
					if (Object.keys(meta).length > 0) methodMetadata = meta;
				}
			} catch {
				/* method metadata unavailable — omit silently */
			}
		}

		return {
			status: "found",
			symbol: {
				uid: sym.id || sym[0],
				name: sym.name || sym[1],
				kind: symKind,
				filePath: sym.filePath || sym[3],
				startLine: sym.startLine || sym[4],
				endLine: sym.endLine || sym[5],
				...(include_content && (sym.content || sym[6])
					? { content: sym.content || sym[6] }
					: {}),
				...(methodMetadata ? { methodMetadata } : {}),
			},
			incoming: categorize(incomingRows),
			outgoing: categorize(outgoingRows),
			...(typedPropertyRows.length > 0
				? {
						typed_properties: typedPropertyRows.map((r: any) => ({
							uid: r.uid || r[0],
							name: r.name || r[1],
							filePath: r.filePath || r[2],
							kind: r.kind || r[3],
							declaredType: r.declaredType || r[4],
						})),
					}
				: {}),
			processes: processRows.map((r: any) => ({
				id: r.pid || r[0],
				name: r.label || r[1],
				step_index: r.step || r[2],
				step_count: r.stepCount || r[3],
			})),
		};
	}

	/**
	 * Detect changes — git-diff based impact analysis.
	 * Maps changed lines to indexed symbols, then finds affected processes.
	 */
}
