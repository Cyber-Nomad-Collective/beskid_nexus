import { logger } from "../../../core/logger.js";
import type { RegistryEntry } from "../../../storage/repo-manager.js";

/**
 * Quick test-file detection for filtering impact results.
 * Matches common test file patterns across all supported languages.
 */
export function isTestFilePath(filePath: string): boolean {
	const p = filePath.toLowerCase().replace(/\\/g, "/");
	return (
		p.includes(".test.") ||
		p.includes(".spec.") ||
		p.includes("__tests__/") ||
		p.includes("__mocks__/") ||
		p.includes("/test/") ||
		p.includes("/tests/") ||
		p.includes("/testing/") ||
		p.includes("/fixtures/") ||
		p.endsWith("_test.go") ||
		p.endsWith("_test.py") ||
		p.endsWith("_spec.rb") ||
		p.endsWith("_test.rb") ||
		p.includes("/spec/") ||
		p.includes("/test_") ||
		p.includes("/conftest.")
	);
}

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS = new Set([
	"File",
	"Folder",
	"Function",
	"Class",
	"Interface",
	"Method",
	"CodeElement",
	"Community",
	"Process",
	"Struct",
	"Enum",
	"Macro",
	"Typedef",
	"Union",
	"Namespace",
	"Trait",
	"Impl",
	"TypeAlias",
	"Const",
	"Static",
	"Property",
	"Record",
	"Delegate",
	"Annotation",
	"Constructor",
	"Template",
	"Module",
	"Route",
	"Tool",
]);

/** Valid relation types for impact analysis filtering */
export const VALID_RELATION_TYPES = new Set([
	"CALLS",
	"IMPORTS",
	"EXTENDS",
	"IMPLEMENTS",
	"HAS_METHOD",
	"HAS_PROPERTY",
	"METHOD_OVERRIDES",
	"OVERRIDES", // Legacy alias — dual-read for pre-rename indexes
	"METHOD_IMPLEMENTS",
	"ACCESSES",
	"HANDLES_ROUTE",
	"FETCHES",
	"HANDLES_TOOL",
	"ENTRY_POINT_OF",
	"WRAPS",
]);

/**
 * Per-relation-type confidence floor for impact analysis.
 *
 * When the graph stores a relation with a confidence value, that stored
 * value is used as-is (it reflects resolution-tier accuracy from analysis
 * time).  This map provides the floor for each edge type when no stored
 * confidence is available, and is also used for display / tooltip hints.
 *
 * Rationale:
 *   CALLS / IMPORTS  – direct, strongly-typed references → 0.9
 *   EXTENDS          – class hierarchy, statically verifiable → 0.85
 *   IMPLEMENTS       – interface contract, statically verifiable → 0.85
 *   METHOD_OVERRIDES  – method override, statically verifiable → 0.85
 *   METHOD_IMPLEMENTS – interface method implementation, statically verifiable → 0.85
 *   HAS_METHOD       – structural containment → 0.95
 *   HAS_PROPERTY     – structural containment → 0.95
 *   ACCESSES         – field read/write, may be indirect → 0.8
 *   CONTAINS         – folder/file containment → 0.95
 *   (unknown type)   – conservative fallback → 0.5
 */
export const IMPACT_RELATION_CONFIDENCE: Readonly<Record<string, number>> = {
	CALLS: 0.9,
	IMPORTS: 0.9,
	EXTENDS: 0.85,
	IMPLEMENTS: 0.85,
	METHOD_OVERRIDES: 0.85,
	METHOD_IMPLEMENTS: 0.85,
	HAS_METHOD: 0.95,
	HAS_PROPERTY: 0.95,
	ACCESSES: 0.8,
	CONTAINS: 0.95,
};

/**
 * Return the confidence floor for a given relation type.
 * Falls back to 0.5 for unknown types so they are not silently elevated.
 */
export const confidenceForRelType = (relType: string | undefined): number =>
	IMPACT_RELATION_CONFIDENCE[relType ?? ""] ?? 0.5;

/** Structured error logging for query failures — replaces empty catch blocks */
export function logQueryError(context: string, err: unknown): void {
	const msg = err instanceof Error ? err.message : String(err);
	logger.error({ context, err: msg }, "GitNexus query failed");
}

/**
 * Per-query latency telemetry for production aggregation (#553).
 *
 * Logged at `debug` level — timing is observability/telemetry, not an
 * error. Operators wanting per-query timing set `GITNEXUS_LOG_LEVEL=debug`
 * (or equivalent). Emitting at `error` level (the original migration
 * artifact) caused alerting rules to fire on every successful query and
 * inflated stderr noise for every MCP/CLI invocation.
 *
 * Emitted via the project logger which routes to stderr — never stdout —
 * because the MCP stdio transport uses stdout exclusively for JSON-RPC
 * responses (#324) and the CLI e2e test `tool output goes to stdout via
 * fd 1` asserts stdout parses cleanly as JSON.
 */
export function logQueryTiming(query: string, phases: Record<string, number>): void {
	const totalMs =
		phases.wall ?? Object.values(phases).reduce((a, b) => a + b, 0);
	const truncated = query.length > 80 ? `${query.slice(0, 80)}…` : query;
	logger.debug({ query: truncated, totalMs, phases }, "GitNexus query timing");
}

export interface CodebaseContext {
	projectName: string;
	stats: {
		fileCount: number;
		functionCount: number;
		communityCount: number;
		processCount: number;
	};
}

export interface RepoHandle {
	id: string; // unique key = repo name (basename)
	name: string;
	repoPath: string;
	storagePath: string;
	lbugPath: string;
	indexedAt: string;
	lastCommit: string;
	remoteUrl?: string;
	stats?: RegistryEntry["stats"];
}


