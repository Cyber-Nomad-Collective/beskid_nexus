import { ProcessesBackend } from "./processes.js";

export class DispatchBackend extends ProcessesBackend {
	async callTool(method: string, params: any): Promise<any> {
		if (method === "list_repos") {
			return this.listRepos();
		}

		if (method.startsWith("group_")) {
			return this.handleGroupTool(method, params || {});
		}

		const p =
			params && typeof params === "object"
				? (params as Record<string, unknown>)
				: {};
		if (
			(method === "impact" || method === "query" || method === "context") &&
			typeof p.repo === "string" &&
			p.repo.startsWith("@")
		) {
			return this.callToolAtGroupRepo(method, p);
		}

		// Resolve repo from optional param (re-reads registry on miss)
		const repo = await this.resolveRepo(
			(params as { repo?: string } | undefined)?.repo,
		);

		switch (method) {
			case "query":
				return this.query(repo, params);
			case "cypher": {
				const raw = await this.cypher(repo, params);
				return this.formatCypherAsMarkdown(raw);
			}
			case "context":
				return this.context(repo, params);
			case "impact":
				return this.impact(repo, params);
			case "detect_changes":
				return this.detectChanges(repo, params);
			case "rename":
				return this.rename(repo, params);
			// Legacy aliases for backwards compatibility
			case "search":
				return this.query(repo, params);
			case "explore":
				return this.context(repo, { name: params?.name, ...params });
			case "overview":
				return this.overview(repo, params);
			case "route_map":
				return this.routeMap(repo, params);
			case "shape_check":
				return this.shapeCheck(repo, params);
			case "tool_map":
				return this.toolMap(repo, params);
			case "api_impact":
				return this.apiImpact(repo, params);
			default:
				throw new Error(`Unknown tool: ${method}`);
		}
	}

	// ─── Tool Implementations ────────────────────────────────────────

	/**
	 * Query tool — process-grouped search.
	 *
	 * 1. Hybrid search (BM25 + semantic) to find matching symbols
	 * 2. Trace each match to its process(es) via STEP_IN_PROCESS
	 * 3. Group by process, rank by aggregate relevance + internal cluster cohesion
	 * 4. Return: { processes, process_symbols, definitions }
	 */
}

