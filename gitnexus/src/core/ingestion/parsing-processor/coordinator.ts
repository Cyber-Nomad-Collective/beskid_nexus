import type { KnowledgeGraph } from "../../graph/types.js";
import { logger } from "../../logger.js";
import type { ASTCache } from "../ast-cache.js";
import type { SymbolTableWriter } from "../model/index.js";
import type { ParseWorkerResult } from "../workers/parse-worker.js";
import type { WorkerPool } from "../workers/worker-pool.js";
import type {
	FileProgressCallback,
	WorkerExtractedData,
} from "./contracts.js";
import { processParsingSequential } from "./sequential.js";
import { processParsingWithWorkers } from "./worker-orchestration.js";

export const processParsing = async (
	graph: KnowledgeGraph,
	files: { path: string; content: string }[],
	symbolTable: SymbolTableWriter,
	astCache: ASTCache,
	/**
	 * Persistent tree cache (separate from `astCache`, which the caller
	 * clears between chunks). Sequential parses additionally write the
	 * Tree here so cross-phase consumers (scope-resolution) can read it.
	 * Worker-mode parses skip — Trees can't cross MessageChannels.
	 * Pass `undefined` if no consumer needs cross-phase access.
	 */
	scopeTreeCache: ASTCache | undefined,
	onFileProgress?: FileProgressCallback,
	workerPool?: WorkerPool,
	/**
	 * Optional out-parameter for the incremental parse cache. When
	 * provided AND the worker-pool path runs successfully, populated
	 * with the raw `ParseWorkerResult[]` from the workers (pre-merge).
	 * Stays empty for the sequential fallback path (no per-chunk
	 * artifact to cache there). See `gitnexus/src/storage/parse-cache.ts`.
	 */
	outRawResults?: ParseWorkerResult[],
): Promise<WorkerExtractedData | null> => {
	let lastProgress = 0;
	const reportProgress: FileProgressCallback | undefined = onFileProgress
		? (current, total, detail) => {
				lastProgress = Math.max(lastProgress, current);
				onFileProgress(lastProgress, total, detail);
			}
		: undefined;

	if (workerPool) {
		if (
			scopeTreeCache !== undefined &&
			process.env.PROF_SCOPE_RESOLUTION === "1"
		) {
			// Trees can't cross MessageChannels, so worker-parsed files land
			// in scope-resolution with an empty cache and get re-parsed.
			// Surfacing this in PROF mode prevents silent perf cliffs when
			// a repo crosses the worker-pool threshold.
			logger.warn(
				`[scope-resolution prof] worker pool engaged for ${files.length} files — cross-phase tree cache will be empty; scope-resolution re-parses.`,
			);
		}
		try {
			return await processParsingWithWorkers(
				graph,
				files,
				symbolTable,
				astCache,
				workerPool,
				reportProgress,
				outRawResults,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(
				{ message },
				"Worker pool parsing stopped; continuing with sequential parser:",
			);
			reportProgress?.(
				lastProgress,
				files.length,
				`Sequential fallback after worker issue: ${message}`,
			);
		}
	}

	// Fallback: sequential parsing (no pre-extracted data)
	await processParsingSequential(
		graph,
		files,
		symbolTable,
		astCache,
		scopeTreeCache,
		reportProgress,
	);
	return null;
};
