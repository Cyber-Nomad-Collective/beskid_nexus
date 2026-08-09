import { generateAIContextFiles } from "../../cli/ai-context.js";
import type { PipelineResult } from "../../types/pipeline.js";
import type { AnalyzeOptions } from "./contracts.js";

interface GenerateAnalysisContextOptions {
	repoPath: string;
	storagePath: string;
	projectName: string;
	pipelineResult: PipelineResult;
	stats: { nodes: number; edges: number };
	options: AnalyzeOptions;
}

export async function generateAnalysisContext({
	repoPath,
	storagePath,
	projectName,
	pipelineResult,
	stats,
	options,
}: GenerateAnalysisContextOptions): Promise<void> {
	// ── Generate AI context files (best-effort) ───────────────────────
	let aggregatedClusterCount = 0;
	if (pipelineResult.communityResult?.communities) {
		const groups = new Map<string, number>();
		for (const c of pipelineResult.communityResult.communities) {
			const label = c.heuristicLabel || c.label || "Unknown";
			groups.set(label, (groups.get(label) || 0) + c.symbolCount);
		}
		aggregatedClusterCount = Array.from(groups.values()).filter(
			(count) => count >= 5,
		).length;
	}

	try {
		await generateAIContextFiles(
			repoPath,
			storagePath,
			projectName,
			{
				files: pipelineResult.totalFileCount,
				nodes: stats.nodes,
				edges: stats.edges,
				communities: pipelineResult.communityResult?.stats.totalCommunities,
				clusters: aggregatedClusterCount,
				processes: pipelineResult.processResult?.stats.totalProcesses,
			},
			undefined,
			{
				skipAgentsMd: options.skipAgentsMd,
				skipSkills: options.skipSkills,
				noStats: options.noStats,
			},
		);
	} catch {
		// Best-effort — don't fail the entire analysis for context file issues
	}
}
