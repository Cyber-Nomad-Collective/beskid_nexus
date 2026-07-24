/**
 * Pipeline Phases — barrel export.
 *
 * Exports all phases, the runner, types, and shared utilities
 * for the ingestion pipeline.
 */

// ── Phase exports (in dependency order) ────────────────────────────────────

export {
	type ScopeResolutionOutput,
	scopeResolutionPhase,
} from "../scope-resolution/pipeline/phase.js";
export { type CobolOutput, cobolPhase } from "./cobol.js";
export { type CommunitiesOutput, communitiesPhase } from "./communities.js";
export { type CrossFileOutput, crossFilePhase } from "./cross-file.js";
export { type MarkdownOutput, markdownPhase } from "./markdown.js";
export { type MROOutput, mroPhase } from "./mro.js";
export { type ORMOutput, ormPhase } from "./orm.js";
export { type ParseOutput, parsePhase } from "./parse.js";
export { type ProcessesOutput, processesPhase } from "./processes.js";
export { type RouteEntry, type RoutesOutput, routesPhase } from "./routes.js";
export { type ScanOutput, scanPhase } from "./scan.js";
export { type StructureOutput, structurePhase } from "./structure.js";
export { type ToolDef, type ToolsOutput, toolsPhase } from "./tools.js";

// ── Infrastructure ─────────────────────────────────────────────────────────

export { runPipeline } from "./runner.js";
export type { PhaseResult, PipelineContext, PipelinePhase } from "./types.js";
export { getPhaseOutput } from "./types.js";
