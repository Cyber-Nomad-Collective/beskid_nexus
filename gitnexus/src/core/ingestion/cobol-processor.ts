/**
 * COBOL Processor
 *
 * Standalone regex-based processor for COBOL and JCL files.
 * Follows the markdown-processor.ts pattern: takes (graph, files, allPathSet),
 * does its own extraction, and writes directly to the graph.
 */
export type { CobolProcessResult } from "./cobol-processor/contracts.js";
export {
	isCobolFile,
	isJclFile,
	processCobol,
} from "./cobol-processor/preprocessing.js";
