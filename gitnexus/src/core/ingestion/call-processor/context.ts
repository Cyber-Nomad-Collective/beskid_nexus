import type { SymbolDefinition } from "gitnexus-shared";
import type { KnowledgeGraph } from "../../graph/types.js";
import type { ASTCache } from "../ast-cache.js";
import type { DispatchDecision, ReceiverEnriched } from "../call-types.js";
import type {
	ExtractedHeritage,
	HeritageMap,
	SymbolTableReader,
} from "../model/index.js";
import {
	CALL_TARGET_TYPES,
	CLASS_TYPES,
	lookupMethodByOwnerWithMRO,
} from "../model/index.js";
import { getLanguageFromFilename, SupportedLanguages } from "gitnexus-shared";
import Parser from "tree-sitter";
import { generateId } from "../../../lib/utils.js";
import { logger } from "../../logger.js";
import {
	isLanguageAvailable,
	loadLanguage,
	loadParser,
} from "../../tree-sitter/parser-loader.js";
import { parseSourceSafe } from "../../tree-sitter/safe-parse.js";
import type { BindingAccumulator } from "../binding-accumulator.js";
import { getTreeSitterBufferSize } from "../constants.js";
import type { FieldExtractorContext, FieldInfo } from "../field-types.js";
import type { LanguageProvider } from "../language-provider.js";
import { getProvider } from "../languages/index.js";
import type { MethodInfo } from "../method-types.js";
import type {
	ResolutionContext,
	TieredCandidates,
} from "../model/resolution-context.js";
import {
	type ResolutionTier,
	TIER_CONFIDENCE,
} from "../model/resolution-context.js";
import { isRegistryPrimary } from "../registry-primary-flag.js";
import { normalizeFetchURL, routeMatches } from "../route-extractors/nextjs.js";
import type { ConstructorBinding, TypeEnvironment } from "../type-env.js";
import { buildTypeEnv, isSubclassOf } from "../type-env.js";
import {
	extractReturnTypeName,
	stripNullable,
} from "../type-extractors/shared.js";
import type { LiteralTypeInferrer } from "../type-extractors/types.js";
import type { SyntaxNode } from "../utils/ast-helpers.js";
import {
	CLASS_CONTAINER_TYPES,
	FUNCTION_NODE_TYPES,
	findEnclosingClassInfo,
	genericFuncName,
	inferFunctionLabel,
} from "../utils/ast-helpers.js";
import {
	countCallArguments,
	extractCallArgTypes,
	extractMixedChain,
	extractReceiverName,
	extractReceiverNode,
	inferCallForm,
	type MixedChainStep,
} from "../utils/call-analysis.js";
import { yieldToEventLoop } from "../utils/event-loop.js";
import {
	buildCollisionGroups,
	constTagForId,
	typeTagForId,
} from "../utils/method-props.js";
import { isVerboseIngestionEnabled } from "../utils/verbose.js";
import { extractTemplateComponents } from "../vue-sfc-extractor.js";
import type {
	ExtractedAssignment,
	ExtractedCall,
	ExtractedFetchCall,
	ExtractedRoute,
	FileConstructorBindings,
} from "../workers/parse-worker.js";

/** Shorthand for the receiver-source discriminant shared across the DAG. */
export type ReceiverSource = ReceiverEnriched["receiverSource"];

export const receiverKey = (scope: string, varName: string): string =>
	`${scope}\0${varName}`;

/**
 * DAG stage 4 fallback: used when `selectDispatch` is absent or returns null.
 * Preserves pre-DAG dispatch semantics:
 *   - 'constructor'         → constructor branch
 *   - 'free'                → free branch (admits class-target fast path)
 *   - 'member' or undefined → owner-scoped branch
 *
 * `undefined` callForm MUST route through owner-scoped (not free) so bare
 * identifiers without a classified shape do NOT trigger `resolveFreeCall`'s
 * class-target fast path. Without a `receiverTypeName`, the owner-scoped
 * branch falls through to `resolveModuleAliasedCall` + `singleCandidate`,
 * matching legacy behavior where non-callable symbols (Class, Interface)
 * null-route instead of producing spurious Constructor edges.
 */
export const defaultDispatchDecision = (
	callForm: "free" | "member" | "constructor" | undefined,
): DispatchDecision => {
	if (callForm === "constructor") return { primary: "constructor" };
	if (callForm === "free") return { primary: "free" };
	return { primary: "owner-scoped" };
};

// ── Property-prepass helpers (parity with parse-worker.ts) ──
// These mirror the sequential-path equivalents in parse-worker.ts so the main-
// thread `processCalls` pre-pass produces byte-identical Property nodes/symbols
// to the worker pool. Drift between the two paths breaks the
// `incremental ≡ --force` invariant the moment a repo crosses the worker
// threshold between runs.

/** Walk up to the nearest enclosing class/struct/interface AST node. */
export const findEnclosingClassNode = (node: SyntaxNode): SyntaxNode | null => {
	let current = node.parent;
	while (current) {
		if (CLASS_CONTAINER_TYPES.has(current.type)) return current;
		current = current.parent;
	}
	return null;
};

/** No-op SymbolTable stub for FieldExtractorContext — matches parse-worker. */
export const NOOP_SYMBOL_TABLE: SymbolTableReader = {
	lookupExact: () => undefined,
	lookupExactFull: () => undefined,
	lookupExactAll: () => [],
	lookupCallableByName: () => [],
	getFiles: () => [][Symbol.iterator](),
	getStats: () => ({ fileCount: 0 }),
};

/**
 * Extract (and cache) field info for a class node. Cache is passed in so it
 * stays scoped to a single `processCalls` invocation rather than leaking
 * across analyze runs (worker uses module-level caching because each worker
 * process is short-lived; the main thread is not).
 *
 * Cache key is `${filePath}:${classNode.startIndex}` — startIndex alone is a
 * per-file byte offset, so almost every Ruby/Python file's leading class lands
 * at byte 0 and would collide across files in the shared map.
 */
export const getFieldInfo = (
	classNode: SyntaxNode,
	provider: LanguageProvider,
	context: FieldExtractorContext,
	cache: Map<string, Map<string, FieldInfo>>,
): Map<string, FieldInfo> | undefined => {
	if (!provider.fieldExtractor) return undefined;
	const cacheKey = `${context.filePath}:${classNode.startIndex}`;
	const cached = cache.get(cacheKey);
	if (cached) return cached;
	const result = provider.fieldExtractor.extract(classNode, context);
	if (!result?.fields?.length) return undefined;
	const map = new Map<string, FieldInfo>();
	for (const field of result.fields) map.set(field.name, field);
	cache.set(cacheKey, map);
	return map;
};

/** Per-file resolved type bindings for exported symbols.
 *  Populated during call processing, consumed by Phase 14 re-resolution pass. */
export type ExportedTypeMap = Map<string, Map<string, string>>;

/**
 * Type labels treated as class-like **method-dispatch receivers** by the call
 * resolver — the set walked by the MRO / heritage path for member and static
 * method calls.
 *
 * Derived from `CLASS_TYPES` (the heritage-index set in symbol-table) plus
 * `Impl` — Rust `impl` blocks are the definition site of methods for a struct
 * and must be walkable as receiver-type candidates even though they are not
 * indexed by `lookupClassByName` (which keys off struct/trait names). Keeping
 * this set a strict superset of `CLASS_TYPES` guarantees that anything
 * reachable via `lookupClassByName` also passes this filter, so the two call
 * paths cannot diverge silently.
 *
 * `Interface` is included even though interfaces cannot be directly
 * instantiated in Java/C#/TypeScript: the resolver still needs to reach
 * interface nodes for static-method dispatch (`Interface.staticMethod()`) and
 * default-method resolution via the MRO walker.
 *
 * **Do not reuse this set for constructor-fallback filtering.** Constructors
 * can only instantiate a narrower subset — see `INSTANTIABLE_CLASS_TYPES`
 * below. `resolveStaticCall`'s step-5 class-node fallback uses the narrower
 * set to prevent false `CALLS` edges from constructor-shaped calls to
 * `Interface`, `Trait`, or `Impl` nodes.
 */
export const CLASS_LIKE_TYPES = new Set<string>([...CLASS_TYPES, "Impl"]);

/**
 * Type labels that can be the target of a constructor-shaped call when no
 * explicit `Constructor` symbol is indexed — the "return the type itself as
 * the call target" fallback set.
 *
 * Strict subset of both `CLASS_LIKE_TYPES` and `CONSTRUCTOR_TARGET_TYPES`.
 * Excludes:
 *   - `Interface` / `Trait` — not instantiable by definition in any
 *     supported language.
 *   - `Impl` — Rust `impl` blocks are method-definition containers, not
 *     the type itself; the owning `Struct` is the correct target.
 *   - `Enum` — excluded pending language-specific support with motivating
 *     test fixtures (matches `CONSTRUCTOR_TARGET_TYPES`).
 *
 * Used exclusively by `resolveStaticCall`'s step-5 class-node fallback.
 * Keep in sync with `CONSTRUCTOR_TARGET_TYPES` (which additionally contains
 * `'Constructor'` for explicit-constructor-node filtering) when extending.
 */
export const INSTANTIABLE_CLASS_TYPES = new Set<string>([
	"Class",
	"Struct",
	"Record",
]);

export const MAX_EXPORTS_PER_FILE = 500;
export const MAX_TYPE_NAME_LENGTH = 256;

export {
	CALL_TARGET_TYPES,
	CLASS_CONTAINER_TYPES,
	CLASS_TYPES,
	FUNCTION_NODE_TYPES,
	Parser,
	SupportedLanguages,
	TIER_CONFIDENCE,
	buildCollisionGroups,
	buildTypeEnv,
	constTagForId,
	countCallArguments,
	extractCallArgTypes,
	extractMixedChain,
	extractReceiverName,
	extractReceiverNode,
	extractReturnTypeName,
	extractTemplateComponents,
	findEnclosingClassInfo,
	generateId,
	genericFuncName,
	getLanguageFromFilename,
	getProvider,
	getTreeSitterBufferSize,
	inferCallForm,
	inferFunctionLabel,
	isLanguageAvailable,
	isRegistryPrimary,
	isSubclassOf,
	isVerboseIngestionEnabled,
	loadLanguage,
	loadParser,
	logger,
	lookupMethodByOwnerWithMRO,
	normalizeFetchURL,
	parseSourceSafe,
	routeMatches,
	stripNullable,
	typeTagForId,
	yieldToEventLoop,
};
export type {
	ASTCache,
	BindingAccumulator,
	ConstructorBinding,
	DispatchDecision,
	ExtractedAssignment,
	ExtractedCall,
	ExtractedFetchCall,
	ExtractedHeritage,
	ExtractedRoute,
	FieldExtractorContext,
	FieldInfo,
	FileConstructorBindings,
	HeritageMap,
	KnowledgeGraph,
	LanguageProvider,
	LiteralTypeInferrer,
	MethodInfo,
	MixedChainStep,
	ReceiverEnriched,
	ResolutionContext,
	ResolutionTier,
	SymbolDefinition,
	SymbolTableReader,
	SyntaxNode,
	TieredCandidates,
	TypeEnvironment,
};
