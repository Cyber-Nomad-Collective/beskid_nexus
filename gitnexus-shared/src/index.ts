// Graph types
export type {
	GraphNode,
	GraphRelationship,
	NodeLabel,
	NodeProperties,
	RelationshipType,
} from "./graph/types.js";
export type { CircuitBreakerOptions } from "./integrations/circuit-breaker.js";
export {
	CircuitBreaker,
	CircuitOpenError,
	getBreaker,
} from "./integrations/circuit-breaker.js";
export type { ResilientFetchOptions } from "./integrations/resilient-fetch.js";
export {
	parseRetryAfter,
	RETRY_AFTER_CAP_MS,
	ResilientFetchExhaustedError,
	resilientFetch,
} from "./integrations/resilient-fetch.js";
export type { RetryDecision, RetryOptions } from "./integrations/retry.js";
// Resilient fetch primitives — bounded retries + per-process circuit breaker.
// Test-only helpers (`__resetBreakerRegistry__`, `classifyOutcome`) are
// reachable via the separate `gitnexus-shared/test-helpers` subpath; do
// NOT add them here. Production consumers must not call them.
export { computeBackoffMs, withRetry } from "./integrations/retry.js";
export type { UqDispatchPayload } from "./integrations/understand-quickly.js";
// Understand-Quickly registry integration (opt-in)
export {
	buildUqDispatchPayload,
	isValidOwnerRepo,
	parseOwnerRepoFromRemote,
	stripGitSuffix,
	UNDERSTAND_QUICKLY_DISPATCH_URL,
	UNDERSTAND_QUICKLY_EVENT_TYPE,
	UNDERSTAND_QUICKLY_TOKEN_ENV,
} from "./integrations/understand-quickly.js";
export {
	getLanguageFromFilename,
	getSyntaxLanguageFromFilename,
} from "./language-detection.js";
// Language support
export { SupportedLanguages } from "./languages.js";
export type { NodeTableName, RelType } from "./lbug/schema-constants.js";
// Schema constants
export {
	EMBEDDING_TABLE_NAME,
	NODE_TABLES,
	REL_TABLE_NAME,
	REL_TYPES,
} from "./lbug/schema-constants.js";
export type { MroStrategy } from "./mro-strategy.js";
// Pipeline progress
export type { PipelinePhase, PipelineProgress } from "./pipeline.js";
export type { DefIndex } from "./scope-resolution/def-index.js";
// Core indexes over per-file artifacts (RFC §3.1; Ring 2 SHARED #913)
export { buildDefIndex } from "./scope-resolution/def-index.js";
// Evidence + tie-break constants (RFC Appendix A, Appendix B)
export {
	EvidenceWeights,
	typeBindingWeightAtDepth,
} from "./scope-resolution/evidence-weights.js";
export type {
	FinalizedScc,
	FinalizeFile,
	FinalizeHooks,
	FinalizeInput,
	FinalizeOutput,
	FinalizeStats,
} from "./scope-resolution/finalize-algorithm.js";
// SCC-aware cross-file finalize (RFC §3.2 Phase 2; Ring 2 SHARED #915)
export { finalize } from "./scope-resolution/finalize-algorithm.js";
export type { LanguageClassification } from "./scope-resolution/language-classification.js";
// Language classification (RFC §6.1 Ring 3/4 governance)
export {
	isProductionLanguage,
	LanguageClassifications,
} from "./scope-resolution/language-classification.js";
export type {
	MethodDispatchIndex,
	MethodDispatchInput,
} from "./scope-resolution/method-dispatch-index.js";
// Method-dispatch materialized view over HeritageMap (RFC §3.1; Ring 2 SHARED #914)
export { buildMethodDispatchIndex } from "./scope-resolution/method-dispatch-index.js";
export type {
	ModuleScopeEntry,
	ModuleScopeIndex,
} from "./scope-resolution/module-scope-index.js";
export { buildModuleScopeIndex } from "./scope-resolution/module-scope-index.js";
export type { OriginForTieBreak } from "./scope-resolution/origin-priority.js";
export { ORIGIN_PRIORITY } from "./scope-resolution/origin-priority.js";
// ScopeExtractor output contracts (RFC §3.2 Phase 1; Ring 2 PKG #919)
export type { ParsedFile } from "./scope-resolution/parsed-file.js";
export type { PositionIndex } from "./scope-resolution/position-index.js";
export { buildPositionIndex } from "./scope-resolution/position-index.js";
export type { QualifiedNameIndex } from "./scope-resolution/qualified-name-index.js";
export { buildQualifiedNameIndex } from "./scope-resolution/qualified-name-index.js";
export type {
	CallForm,
	ReferenceKind,
	ReferenceSite,
} from "./scope-resolution/reference-site.js";
export type { ClassRegistry } from "./scope-resolution/registries/class-registry.js";
// Scope-aware registries + 7-step lookup (RFC §4; Ring 2 SHARED #917)
export { buildClassRegistry } from "./scope-resolution/registries/class-registry.js";
export type {
	ArityVerdict,
	OwnerScopedContributor,
	RegistryContext,
	RegistryProviders,
} from "./scope-resolution/registries/context.js";
export {
	CLASS_KINDS,
	FIELD_KINDS,
	METHOD_KINDS,
} from "./scope-resolution/registries/context.js";
export type { RawSignals } from "./scope-resolution/registries/evidence.js";
export {
	composeEvidence,
	confidenceFromEvidence,
} from "./scope-resolution/registries/evidence.js";
export type {
	FieldLookupOptions,
	FieldRegistry,
} from "./scope-resolution/registries/field-registry.js";
export { buildFieldRegistry } from "./scope-resolution/registries/field-registry.js";
export type { CoreLookupParams } from "./scope-resolution/registries/lookup-core.js";
export { lookupCore } from "./scope-resolution/registries/lookup-core.js";
export type { LookupQualifiedParams } from "./scope-resolution/registries/lookup-qualified.js";
export { lookupQualified } from "./scope-resolution/registries/lookup-qualified.js";
export type {
	MethodLookupOptions,
	MethodRegistry,
} from "./scope-resolution/registries/method-registry.js";
export { buildMethodRegistry } from "./scope-resolution/registries/method-registry.js";
export type { TieBreakKey } from "./scope-resolution/registries/tie-breaks.js";
export {
	CONFIDENCE_EPSILON,
	compareByConfidenceWithTiebreaks,
} from "./scope-resolution/registries/tie-breaks.js";
export type { ResolveTypeRefContext } from "./scope-resolution/resolve-type-ref.js";
// Strict type-reference resolver (RFC §4.6; Ring 2 SHARED #916)
// `ScopeLookup` is defined in `./scope-resolution/types.js` and exported
// from the type-export block above — not from this module.
export { resolveTypeRef } from "./scope-resolution/resolve-type-ref.js";
export type { ScopeIdInput } from "./scope-resolution/scope-id.js";
// Scope tree spine + position lookup (RFC §2.2 + §3.1; Ring 2 SHARED #912)
export {
	clearScopeIdInternPool,
	makeScopeId,
} from "./scope-resolution/scope-id.js";
export type { ScopeTree } from "./scope-resolution/scope-tree.js";
export {
	buildScopeTree,
	canParentScope,
	ScopeTreeInvariantError,
} from "./scope-resolution/scope-tree.js";
export type {
	LanguageParityRow,
	ShadowParityReport,
} from "./scope-resolution/shadow/aggregate.js";
export { aggregateDiffs } from "./scope-resolution/shadow/aggregate.js";
export type {
	ShadowAgreement,
	ShadowCallsite,
	ShadowDiff,
} from "./scope-resolution/shadow/diff.js";
// Shadow-mode diff + aggregation (RFC §6.3; Ring 2 SHARED #918)
export { diffResolutions } from "./scope-resolution/shadow/diff.js";
// ─── Scope-based resolution — RFC #909 (Ring 1 #910) ────────────────────────
// Data model (RFC §2)
export type { SymbolDefinition } from "./scope-resolution/symbol-definition.js";
export type {
	BindingRef,
	Callsite,
	Capture,
	CaptureMatch,
	DefId,
	ImportEdge,
	LookupParams,
	ParsedImport,
	ParsedTypeBinding,
	Range,
	Reference,
	ReferenceIndex,
	RegistryContributor,
	Resolution,
	ResolutionEvidence,
	Scope,
	ScopeId,
	ScopeKind,
	ScopeLookup,
	TypeRef,
	WorkspaceIndex,
} from "./scope-resolution/types.js";
