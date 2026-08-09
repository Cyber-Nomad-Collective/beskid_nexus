import { ResourcesBackend } from "./resources.js";
import {
	closeLbug,
	executeParameterized,
	executeQuery,
} from "../../../core/lbug/pool-adapter.js";

export class ProcessesBackend extends ResourcesBackend {
	async queryClusters(
		repoName?: string,
		limit = 100,
	): Promise<{ clusters: any[] }> {
		const repo = await this.resolveRepo(repoName);
		await this.ensureInitialized(repo.id);

		try {
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
			return { clusters: this.aggregateClusters(rawClusters).slice(0, limit) };
		} catch {
			return { clusters: [] };
		}
	}

	/**
	 * Query processes directly from graph.
	 * Used by getProcessesResource — avoids legacy overview() dispatch.
	 */
	async queryProcesses(
		repoName?: string,
		limit = 50,
	): Promise<{ processes: any[] }> {
		const repo = await this.resolveRepo(repoName);
		await this.ensureInitialized(repo.id);

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
			return {
				processes: processes.map((p: any) => ({
					id: p.id || p[0],
					label: p.label || p[1],
					heuristicLabel: p.heuristicLabel || p[2],
					processType: p.processType || p[3],
					stepCount: p.stepCount || p[4],
				})),
			};
		} catch {
			return { processes: [] };
		}
	}

	/**
	 * Query cluster detail (members) directly from graph.
	 * Used by getClusterDetailResource.
	 */
	async queryClusterDetail(name: string, repoName?: string): Promise<any> {
		const repo = await this.resolveRepo(repoName);
		await this.ensureInitialized(repo.id);

		const clusters = await executeParameterized(
			repo.id,
			`
      MATCH (c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
    `,
			{ clusterName: name },
		);
		if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

		const rawClusters = clusters.map((c: any) => ({
			id: c.id || c[0],
			label: c.label || c[1],
			heuristicLabel: c.heuristicLabel || c[2],
			cohesion: c.cohesion || c[3],
			symbolCount: c.symbolCount || c[4],
		}));

		let totalSymbols = 0,
			weightedCohesion = 0;
		for (const c of rawClusters) {
			const s = c.symbolCount || 0;
			totalSymbols += s;
			weightedCohesion += (c.cohesion || 0) * s;
		}

		const members = await executeParameterized(
			repo.id,
			`
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.label = $clusterName OR c.heuristicLabel = $clusterName
      RETURN DISTINCT n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
      LIMIT 30
    `,
			{ clusterName: name },
		);

		return {
			cluster: {
				id: rawClusters[0].id,
				label: rawClusters[0].heuristicLabel || rawClusters[0].label,
				heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
				cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
				symbolCount: totalSymbols,
				subCommunities: rawClusters.length,
			},
			members: members.map((m: any) => ({
				name: m.name || m[0],
				type: m.type || m[1],
				filePath: m.filePath || m[2],
			})),
		};
	}

	/**
	 * Query process detail (steps) directly from graph.
	 * Used by getProcessDetailResource.
	 */
	async queryProcessDetail(name: string, repoName?: string): Promise<any> {
		const repo = await this.resolveRepo(repoName);
		await this.ensureInitialized(repo.id);

		const processes = await executeParameterized(
			repo.id,
			`
      MATCH (p:Process)
      WHERE p.label = $processName OR p.heuristicLabel = $processName
      RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
      LIMIT 1
    `,
			{ processName: name },
		);
		if (processes.length === 0) return { error: `Process '${name}' not found` };

		const proc = processes[0];
		const procId = proc.id || proc[0];
		const steps = await executeParameterized(
			repo.id,
			`
      MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: $procId})
      RETURN n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, r.step AS step
      ORDER BY r.step
    `,
			{ procId },
		);

		return {
			process: {
				id: procId,
				label: proc.label || proc[1],
				heuristicLabel: proc.heuristicLabel || proc[2],
				processType: proc.processType || proc[3],
				stepCount: proc.stepCount || proc[4],
			},
			steps: steps.map((s: any) => ({
				step: s.step || s[3],
				name: s.name || s[0],
				type: s.type || s[1],
				filePath: s.filePath || s[2],
			})),
		};
	}

	async disconnect(): Promise<void> {
		await closeLbug(); // close all connections
		// Note: we intentionally do NOT call disposeEmbedder() here.
		// ONNX Runtime's native cleanup segfaults on macOS and some Linux configs,
		// and importing the embedder module on Node v24+ crashes if onnxruntime
		// was never loaded during the session. Since process.exit(0) follows
		// immediately after disconnect(), the OS reclaims everything. See #38, #89.
		this.repos.clear();
		this.contextCache.clear();
		this.initializedRepos.clear();
	}}
