import { parentPort } from "node:worker_threads";
import { processBatch } from "./batch.js";
import { mergeResult } from "./progress.js";
import type { ParseWorkerResult, WorkerIncomingMessage } from "./protocol.js";

// ============================================================================
// Worker message handler — supports sub-batch streaming
// ============================================================================

/** Accumulated result across sub-batches */
let accumulated: ParseWorkerResult = {
	nodes: [],
	relationships: [],
	symbols: [],
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
	skippedLanguages: {},
	fileCount: 0,
};
let cumulativeProcessed = 0;

parentPort?.on("message", (msg: WorkerIncomingMessage) => {
	try {
		// Legacy single-message mode (backward compat): array of files
		if (Array.isArray(msg)) {
			const result = processBatch(msg, (filesProcessed) => {
				parentPort?.postMessage({ type: "progress", filesProcessed });
			});
			parentPort?.postMessage({ type: "result", data: result });
			return;
		}

		// Sub-batch mode: { type: 'sub-batch', files: [...] }
		if (msg.type === "sub-batch") {
			const result = processBatch(msg.files, (filesProcessed) => {
				parentPort?.postMessage({
					type: "progress",
					filesProcessed: cumulativeProcessed + filesProcessed,
				});
			});
			cumulativeProcessed += result.fileCount;
			mergeResult(accumulated, result);
			// Signal ready for next sub-batch
			parentPort?.postMessage({ type: "sub-batch-done" });
			return;
		}

		// Flush: send accumulated results
		if (msg.type === "flush") {
			parentPort?.postMessage({ type: "result", data: accumulated });
			// Reset for potential reuse
			accumulated = {
				nodes: [],
				relationships: [],
				symbols: [],
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
				skippedLanguages: {},
				fileCount: 0,
			};
			cumulativeProcessed = 0;
			return;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		parentPort?.postMessage({ type: "error", error: message });
	}
});
