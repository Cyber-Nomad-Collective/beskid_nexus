import { getLanguageFromFilename } from "gitnexus-shared";
import type { KnowledgeGraph } from "../../graph/types.js";
import { logger } from "../../logger.js";
import type { ASTCache } from "../ast-cache.js";
import type { SymbolTableWriter } from "../model/index.js";
import type {
	ParseWorkerInput,
	ParseWorkerResult,
} from "../workers/parse-worker.js";
import type { WorkerPool } from "../workers/worker-pool.js";
import type {
	FileProgressCallback,
	WorkerExtractedData,
} from "./contracts.js";
import { mergeChunkResults } from "./result-merge.js";

export const processParsingWithWorkers = async (
	graph: KnowledgeGraph,
	files: { path: string; content: string }[],
	symbolTable: SymbolTableWriter,
	_astCache: ASTCache,
	workerPool: WorkerPool,
	onFileProgress?: FileProgressCallback,
	/**
	 * When provided, populated with the raw worker results before merging.
	 * Used by the incremental-indexing parse cache to capture the per-chunk
	 * worker output for caching across runs. The mutation happens in-place
	 * so the caller (parse-impl) can keep a reference. See
	 * `gitnexus/src/storage/parse-cache.ts`.
	 */
	outRawResults?: ParseWorkerResult[],
): Promise<WorkerExtractedData> => {
	// Filter to parseable files only
	const parseableFiles: ParseWorkerInput[] = [];
	for (const file of files) {
		const lang = getLanguageFromFilename(file.path);
		if (lang) parseableFiles.push({ path: file.path, content: file.content });
	}

	if (parseableFiles.length === 0)
		return {
			imports: [],
			calls: [],
			assignments: [],
			heritage: [],
			routes: [],
			fetchCalls: [],
			decoratorRoutes: [],
			toolDefs: [],
			ormQueries: [],
			constructorBindings: [],
			fileScopeBindings: [],
			parsedFiles: [],
		};

	const total = files.length;

	// Dispatch to worker pool — pool handles splitting into chunks and sub-batching
	const chunkResults = await workerPool.dispatch<
		ParseWorkerInput,
		ParseWorkerResult
	>(parseableFiles, (filesProcessed) => {
		onFileProgress?.(Math.min(filesProcessed, total), total, "Parsing...");
	});

	// Capture the raw chunk results for the incremental parse cache before
	// merging — the cache stores the unmerged worker output so a future run
	// can re-merge them into a fresh graph state.
	if (outRawResults) {
		for (const r of chunkResults) outRawResults.push(r);
	}

	// Merge results from all workers into graph and symbol table.
	const merged = mergeChunkResults(graph, symbolTable, chunkResults);

	// Merge and log skipped languages from workers
	const skippedLanguages = new Map<string, number>();
	for (const result of chunkResults) {
		for (const [lang, count] of Object.entries(result.skippedLanguages)) {
			skippedLanguages.set(lang, (skippedLanguages.get(lang) || 0) + count);
		}
	}
	if (skippedLanguages.size > 0) {
		const summary = Array.from(skippedLanguages.entries())
			.map(([lang, count]) => `${lang}: ${count}`)
			.join(", ");
		logger.warn(`  Skipped unsupported languages: ${summary}`);
	}

	// Final progress
	onFileProgress?.(total, total, "done");
	return merged;
};
