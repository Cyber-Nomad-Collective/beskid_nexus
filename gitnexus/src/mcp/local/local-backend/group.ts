import { ImpactBackend } from "./impact.js";
import type { RepoHandle } from "./formatting-errors.js";
import { resolveAtGroupMemberRepoPath } from "../../../core/group/resolve-at-member.js";
import { GroupService, type GroupToolPort } from "../../../core/group/service.js";

export class GroupBackend extends ImpactBackend {
	private groupToolSvc: GroupService | null = null;

	getGroupService(): GroupService {
		if (!this.groupToolSvc) {
			const port: GroupToolPort = {
				resolveRepo: (p) => this.resolveRepo(p),
				impact: (r, p) => this.impact(r as RepoHandle, p),
				query: (r, p) => this.query(r as RepoHandle, p),
				impactByUid: (id, uid, d, o) => this.impactByUid(id, uid, d, o),
				context: (r, p) => this.context(r as RepoHandle, p),
			};
			this.groupToolSvc = new GroupService(port);
		}
		return this.groupToolSvc;
	}

	/** Close all pooled LadybugDB connections (CLI one-shot; optional for long-lived MCP). */
	protected handleGroupTool(
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		switch (method) {
			case "group_list":
				return this.groupList(params);
			case "group_sync":
				return this.groupSync(params);
			default:
				throw new Error(
					`Unknown group tool: ${method}. Removed tools: use repo "@<groupName>" on impact, query, or context (optional "/<memberPath>"), or MCP resources.`,
				);
		}
	}

	/**
	 * Dispatch impact/query/context when `repo` is `@groupName` or `@groupName/memberPath`
	 * (group mode — not the global indexed-repo `repo` parameter).
	 */
	protected async callToolAtGroupRepo(
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		await this.refreshRepos();

		if (
			params.service !== undefined &&
			params.service !== null &&
			String(params.service).trim() === ""
		) {
			return { error: "service must not be an empty string" };
		}

		const raw = String(params.repo).slice(1);
		const slash = raw.indexOf("/");
		const groupName = (slash === -1 ? raw : raw.slice(0, slash)).trim();
		const memberRest =
			slash === -1 ? undefined : raw.slice(slash + 1).trim() || undefined;

		const resolved = await resolveAtGroupMemberRepoPath(groupName, memberRest);
		if (resolved.ok === false) return { error: resolved.error };

		const svc = this.getGroupService();
		if (method === "impact") {
			const impactArgs: Record<string, unknown> = {
				name: groupName,
				repo: resolved.repoPath,
				target: params.target,
				direction: params.direction,
			};
			if (params.maxDepth !== undefined) impactArgs.maxDepth = params.maxDepth;
			if (params.crossDepth !== undefined)
				impactArgs.crossDepth = params.crossDepth;
			if (params.relationTypes !== undefined)
				impactArgs.relationTypes = params.relationTypes;
			if (params.includeTests !== undefined)
				impactArgs.includeTests = params.includeTests;
			if (params.minConfidence !== undefined)
				impactArgs.minConfidence = params.minConfidence;
			if (params.service !== undefined && params.service !== null)
				impactArgs.service = params.service;
			if (typeof params.subgroup === "string")
				impactArgs.subgroup = params.subgroup;
			if (params.timeoutMs !== undefined) impactArgs.timeoutMs = params.timeoutMs;
			if (params.timeout !== undefined) impactArgs.timeout = params.timeout;
			return svc.groupImpact(impactArgs);
		}
		if (method === "query") {
			const queryArgs: Record<string, unknown> = {
				name: groupName,
				query: params.query,
			};
			if (typeof params.task_context === "string")
				queryArgs.task_context = params.task_context;
			if (typeof params.goal === "string") queryArgs.goal = params.goal;
			if (typeof params.limit === "number") queryArgs.limit = params.limit;
			if (typeof params.max_symbols === "number")
				queryArgs.max_symbols = params.max_symbols;
			if (params.include_content !== undefined)
				queryArgs.include_content = params.include_content;
			if (params.service !== undefined && params.service !== null)
				queryArgs.service = params.service;
			if (memberRest !== undefined) {
				queryArgs.subgroup = memberRest;
				queryArgs.subgroupExact = true;
			}
			return svc.groupQuery(queryArgs);
		}
		if (method === "context") {
			const targetSym =
				typeof params.target === "string" && params.target.trim() !== ""
					? params.target.trim()
					: typeof params.name === "string" && params.name.trim() !== ""
						? params.name.trim()
						: undefined;
			const contextArgs: Record<string, unknown> = {
				name: groupName,
				target: targetSym,
			};
			if (typeof params.uid === "string") contextArgs.uid = params.uid;
			if (typeof params.file_path === "string")
				contextArgs.file_path = params.file_path;
			if (params.include_content !== undefined)
				contextArgs.include_content = params.include_content;
			if (params.service !== undefined && params.service !== null)
				contextArgs.service = params.service;
			if (memberRest !== undefined) {
				contextArgs.subgroup = memberRest;
				contextArgs.subgroupExact = true;
			}
			return svc.groupContext(contextArgs);
		}
		throw new Error(`Internal: unsupported group-repo tool ${method}`);
	}

	protected async groupList(params: Record<string, unknown>): Promise<unknown> {
		return this.getGroupService().groupList(params);
	}

	protected async groupSync(params: Record<string, unknown>): Promise<unknown> {
		return this.getGroupService().groupSync(params);
	}

	/**
	 * MCP resource body for `gitnexus://group/{name}/contracts` (Issue #794).
	 */
	async readGroupContractsResource(
		groupName: string,
		filter: { type?: string; repo?: string; unmatchedOnly?: boolean },
	): Promise<string> {
		try {
			const params: Record<string, unknown> = { name: groupName };
			if (filter.type !== undefined) params.type = filter.type;
			if (filter.repo !== undefined) params.repo = filter.repo;
			if (filter.unmatchedOnly === true) params.unmatchedOnly = true;
			const raw = await this.getGroupService().groupContracts(params);
			return GroupBackend.formatGroupResourcePayload(raw);
		} catch (e) {
			return `error: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	/**
	 * MCP resource body for `gitnexus://group/{name}/status` (Issue #794).
	 */
	async readGroupStatusResource(groupName: string): Promise<string> {
		try {
			const raw = await this.getGroupService().groupStatus({ name: groupName });
			return GroupBackend.formatGroupResourcePayload(raw);
		} catch (e) {
			return `error: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	protected static formatGroupResourcePayload(raw: unknown): string {
		if (raw && typeof raw === "object" && "error" in raw) {
			const err = (raw as { error?: unknown }).error;
			if (typeof err === "string" && err.length > 0) {
				return `error: ${err}`;
			}
		}
		return JSON.stringify(raw, null, 2);
	}

	/**
	 * Fetch Route nodes with their consumers in a single query.
	 * Shared by routeMap and shapeCheck to avoid N+1 query patterns.
	 */
}
