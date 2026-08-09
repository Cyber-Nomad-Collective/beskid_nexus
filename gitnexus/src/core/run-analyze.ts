/**
 * Shared Analysis Orchestrator
 *
 * Stable facade for CLI and service-side analysis.
 */
export type {
	AnalyzeCallbacks,
	AnalyzeOptions,
	AnalyzeResult,
} from "./run-analyze/contracts.js";
export type { EmbeddingMode } from "./embedding-mode.js";
export {
	DEFAULT_EMBEDDING_NODE_LIMIT,
	deriveEmbeddingMode,
} from "./embedding-mode.js";
export { PHASE_LABELS } from "./run-analyze/progress.js";
export { runFullAnalysis } from "./run-analyze/coordinator.js";
