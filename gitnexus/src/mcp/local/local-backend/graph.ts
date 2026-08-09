import { SearchBackend } from "./search.js";
import type { RepoHandle } from "./formatting-errors.js";
import {
	isWalCorruptionError,
	WAL_RECOVERY_SUGGESTION,
} from "../../../core/lbug/lbug-config.js";
import {
	executeQuery,
	isLbugReady,
	isWriteQuery,
} from "../../../core/lbug/pool-adapter.js";

export class GraphBackend extends SearchBackend {
	async executeCypher(repoName: string, query: string): Promise<any> {
		const repo = await this.resolveRepo(repoName);
		return this.cypher(repo, { query });
	}

	protected async cypher(
		repo: RepoHandle,
		params: { query: string },
	): Promise<any> {
		await this.ensureInitialized(repo.id);

		if (!isLbugReady(repo.id)) {
			return { error: "LadybugDB not ready. Index may be corrupted." };
		}

		// Block write operations (defense-in-depth — DB is already read-only)
		if (isWriteQuery(params.query)) {
			return {
				error:
					"Write operations (CREATE, DELETE, SET, MERGE, REMOVE, DROP, ALTER, COPY, DETACH) are not allowed. The knowledge graph is read-only.",
			};
		}

		try {
			const result = await executeQuery(repo.id, params.query);
			return result;
		} catch (err: any) {
			const msg = err.message || "Query failed";
			if (isWalCorruptionError(err)) {
				return {
					error: msg,
					recoverySuggestion: WAL_RECOVERY_SUGGESTION,
				};
			}
			return { error: msg };
		}
	}

	/**
	 * Format raw Cypher result rows as a markdown table for LLM readability.
	 * Falls back to raw result if rows aren't tabular objects.
	 */
	protected formatCypherAsMarkdown(result: any): any {
		if (!Array.isArray(result) || result.length === 0) return result;

		const firstRow = result[0];
		if (typeof firstRow !== "object" || firstRow === null) return result;

		const keys = Object.keys(firstRow);
		if (keys.length === 0) return result;

		const header = `| ${keys.join(" | ")} |`;
		const separator = `| ${keys.map(() => "---").join(" | ")} |`;
		const dataRows = result.map(
			(row: any) =>
				"| " +
				keys
					.map((k) => {
						const v = row[k];
						if (v === null || v === undefined) return "";
						if (typeof v === "object") return JSON.stringify(v);
						return String(v);
					})
					.join(" | ") +
				" |",
		);

		return {
			markdown: [header, separator, ...dataRows].join("\n"),
			row_count: result.length,
		};
	}

	/**
	 * Aggregate same-named clusters: group by heuristicLabel, sum symbols,
	 * weighted-average cohesion, filter out tiny clusters (<5 symbols).
	 * Raw communities stay intact in LadybugDB for Cypher queries.
	 */
	protected aggregateClusters(clusters: any[]): any[] {
		const groups = new Map<
			string,
			{
				ids: string[];
				totalSymbols: number;
				weightedCohesion: number;
				largest: any;
			}
		>();

		for (const c of clusters) {
			const label = c.heuristicLabel || c.label || "Unknown";
			const symbols = c.symbolCount || 0;
			const cohesion = c.cohesion || 0;
			const existing = groups.get(label);

			if (!existing) {
				groups.set(label, {
					ids: [c.id],
					totalSymbols: symbols,
					weightedCohesion: cohesion * symbols,
					largest: c,
				});
			} else {
				existing.ids.push(c.id);
				existing.totalSymbols += symbols;
				existing.weightedCohesion += cohesion * symbols;
				if (symbols > (existing.largest.symbolCount || 0)) {
					existing.largest = c;
				}
			}
		}

		return Array.from(groups.entries())
			.map(([label, g]) => ({
				id: g.largest.id,
				label,
				heuristicLabel: label,
				symbolCount: g.totalSymbols,
				cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
				subCommunities: g.ids.length,
			}))
			.filter((c) => c.symbolCount >= 5)
			.sort((a, b) => b.symbolCount - a.symbolCount);
	}

	protected async overview(
		repo: RepoHandle,
		params: { showClusters?: boolean; showProcesses?: boolean; limit?: number },
	): Promise<any> {
		await this.ensureInitialized(repo.id);

		const limit = params.limit || 20;
		const result: any = {
			repo: repo.name,
			repoPath: repo.repoPath,
			stats: repo.stats,
			indexedAt: repo.indexedAt,
			lastCommit: repo.lastCommit,
		};

		if (params.showClusters !== false) {
			try {
				// Fetch more raw communities than the display limit so aggregation has enough data
				const rawLimit = Math.max(limit * 5, 200);
				const clusters = await executeQuery(
					repo.id,
					`
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
          ORDER BY c.symbolCount DESC
          LIMIT ${rawLimit}
        `,
				);
				const rawClusters = clusters.map((c: any) => ({
					id: c.id || c[0],
					label: c.label || c[1],
					heuristicLabel: c.heuristicLabel || c[2],
					cohesion: c.cohesion || c[3],
					symbolCount: c.symbolCount || c[4],
				}));
				result.clusters = this.aggregateClusters(rawClusters).slice(0, limit);
			} catch {
				result.clusters = [];
			}
		}

		if (params.showProcesses !== false) {
			try {
				const processes = await executeQuery(
					repo.id,
					`
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT ${limit}
        `,
				);
				result.processes = processes.map((p: any) => ({
					id: p.id || p[0],
					label: p.label || p[1],
					heuristicLabel: p.heuristicLabel || p[2],
					processType: p.processType || p[3],
					stepCount: p.stepCount || p[4],
				}));
			} catch {
				result.processes = [];
			}
		}

		return result;
	}

	/**
	 * Patch the `type` field on candidates whose `labels(n)[0]` projection
	 * came back empty — a known LadybugDB behaviour for several node types.
	 *
	 * Uses one scoped UNION query across the five priority labels rather
	 * than per-candidate round-trips, so cost is a single DB call regardless
	 * of how many candidates need enrichment. No-op when every candidate
	 * already has a non-empty type.
	 *
	 * Failures are swallowed: label enrichment is an optimisation for
	 * downstream scoring and #480 Class/Interface BFS seeding; if it fails
	 * the symbol still resolves, just without the kind-priority bonus.
	 */
}
