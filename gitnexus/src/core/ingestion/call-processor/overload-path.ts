import {
	CALL_TARGET_TYPES,
	TIER_CONFIDENCE,
	extractCallArgTypes,
	getLanguageFromFilename,
	getProvider,
} from "./context.js";
import type {
	ExtractedCall,
	LiteralTypeInferrer,
	ResolutionContext,
	ResolutionTier,
	SymbolDefinition,
	SyntaxNode,
	TieredCandidates,
	TypeEnvironment,
} from "./context.js";
import type { ResolveResult } from "./type-inference.js";

export const CONSTRUCTOR_TARGET_TYPES = new Set([
	"Constructor",
	"Class",
	"Struct",
	"Record",
]);

/** Per-file cache for module-alias widening. Cleared between files. */
export type WidenCache = Map<string, readonly SymbolDefinition[]>;

export const filterCallableCandidates = (
	candidates: readonly SymbolDefinition[],
	argCount?: number,
	callForm?: "free" | "member" | "constructor",
): SymbolDefinition[] => {
	let kindFiltered: SymbolDefinition[];

	if (callForm === "constructor") {
		const constructors = candidates.filter((c) => c.type === "Constructor");
		if (constructors.length > 0) {
			kindFiltered = constructors;
		} else {
			const types = candidates.filter((c) => CONSTRUCTOR_TARGET_TYPES.has(c.type));
			kindFiltered =
				types.length > 0
					? types
					: candidates.filter((c) => CALL_TARGET_TYPES.has(c.type));
		}
	} else {
		// CALL_TARGET_TYPES (not FREE_CALLABLE_TYPES) — the post-A4 filter must
		// also admit Method and Constructor candidates, which are now unioned
		// into the pool from `model.methods.lookupMethodByName` rather than
		// `symbols.lookupCallableByName`.
		kindFiltered = candidates.filter((c) => CALL_TARGET_TYPES.has(c.type));
	}

	if (kindFiltered.length === 0) return [];
	if (argCount === undefined) return kindFiltered;

	const hasParameterMetadata = kindFiltered.some(
		(candidate) => candidate.parameterCount !== undefined,
	);
	if (!hasParameterMetadata) return kindFiltered;

	return kindFiltered.filter(
		(candidate) =>
			candidate.parameterCount === undefined ||
			(argCount >=
				(candidate.requiredParameterCount ?? candidate.parameterCount) &&
				argCount <= candidate.parameterCount),
	);
};

/**
 * Count callable candidates matching the kind + arity filter without
 * allocating an intermediate array. Short-circuits once count exceeds
 * `threshold` (default 1) — used by the dispatcher's `skipMember` check
 * where we only need to know "more than one survivor".
 */
export const countCallableCandidates = (
	candidates: readonly SymbolDefinition[],
	argCount?: number,
	callForm?: "free" | "member" | "constructor",
	threshold = 1,
): number => {
	let count = 0;
	for (const c of candidates) {
		// Kind filter (mirrors filterCallableCandidates)
		const typeOk =
			callForm === "constructor"
				? CONSTRUCTOR_TARGET_TYPES.has(c.type)
				: CALL_TARGET_TYPES.has(c.type);
		if (!typeOk) continue;
		// Arity filter
		if (
			argCount !== undefined &&
			c.parameterCount !== undefined &&
			(argCount < (c.requiredParameterCount ?? c.parameterCount) ||
				argCount > c.parameterCount)
		) {
			continue;
		}
		count++;
		if (count > threshold) return count; // early exit
	}
	return count;
};

export const toResolveResult = (
	definition: SymbolDefinition,
	tier: ResolutionTier,
): ResolveResult => ({
	nodeId: definition.nodeId,
	confidence: TIER_CONFIDENCE[tier],
	reason:
		tier === "same-file"
			? "same-file"
			: tier === "import-scoped"
				? "import-resolved"
				: "global",
	returnType: definition.returnType,
});

/**
 * Optional hints for overload disambiguation via argument literal types.
 * Only available on the sequential path (has AST); worker path passes undefined.
 *
 * @internal Exported so tests can exercise the D0 skip-condition path without
 *           constructing a real SyntaxNode. Do not use outside `call-processor.ts`
 *           and its unit tests.
 */
export interface OverloadHints {
	callNode: SyntaxNode;
	inferLiteralType: LiteralTypeInferrer;
	typeEnv?: TypeEnvironment;
}

/**
 * Kotlin often declares parameters with boxed names (`Int`, `Boolean`, …) while
 * literal inference yields JVM primitives (`int`, `boolean`). This map aligns
 * those for overload matching. Java parameter text is usually already primitive
 * spellings, so lookups here are typically unchanged.
 */
const KOTLIN_BOXED_TO_PRIMITIVE: Readonly<Record<string, string>> = {
	Int: "int",
	Long: "long",
	Short: "short",
	Byte: "byte",
	Float: "float",
	Double: "double",
	Boolean: "boolean",
	Char: "char",
};

const normalizeJvmTypeName = (name: string): string =>
	KOTLIN_BOXED_TO_PRIMITIVE[name] ?? name;

export const matchCandidatesByArgTypes = (
	candidates: SymbolDefinition[],
	argTypes: (string | undefined)[],
): SymbolDefinition | null => {
	if (!candidates.some((c) => c.parameterTypes)) return null;

	const matched = candidates.filter((c) => {
		// Keep candidates without type info — conservative: partially-annotated codebases
		// (e.g. C++ with some missing declarations) may have mixed typed/untyped overloads.
		// If one typed and one untyped both survive, matched.length > 1 → returns null (no edge).
		if (!c.parameterTypes) return true;
		return c.parameterTypes.every((pType, i) => {
			if (i >= argTypes.length || !argTypes[i]) return true;
			// Normalise Kotlin boxed type names (Int→int, Boolean→boolean, etc.) so
			// that the stored declaration type matches the inferred literal type.
			return normalizeJvmTypeName(pType) === argTypes[i];
		});
	});

	if (matched.length === 1) return matched[0];
	// Multiple survivors may share the same nodeId (e.g. TypeScript overload signatures +
	// implementation body all collide via generateId). Deduplicate by nodeId — if all
	// matched candidates resolve to the same graph node, disambiguation succeeded.
	if (matched.length > 1) {
		const uniqueIds = new Set(matched.map((c) => c.nodeId));
		if (uniqueIds.size === 1) return matched[0];
	}
	return null;
};

/**
 * Try to disambiguate overloaded candidates using argument literal types.
 * Only invoked when filteredCandidates.length > 1 and at least one has parameterTypes.
 * Returns the single matching candidate, or null if ambiguous/inconclusive.
 */
export const tryOverloadDisambiguation = (
	candidates: SymbolDefinition[],
	hints: OverloadHints,
): SymbolDefinition | null => {
	const argTypes = extractCallArgTypes(
		hints.callNode,
		hints.inferLiteralType,
		hints.typeEnv
			? (varName, cn) => hints.typeEnv?.lookup(varName, cn)
			: undefined,
	);
	if (!argTypes) return null;
	return matchCandidatesByArgTypes(candidates, argTypes);
};

/**
 * Apply overload-hint or arg-type disambiguation to a pre-filtered candidate
 * pool. Returns the unique survivor, or null when neither signal is present,
 * neither can disambiguate, or the pool remains ambiguous.
 *
 * Precedence rule: `overloadHints` wins over `preComputedArgTypes` when both
 * are supplied. The AST-based disambiguator has access to live type inference
 * hooks, whereas `preComputedArgTypes` is a worker-path pre-computation that
 * may be coarser-grained.
 *
 * Single source of truth for the narrowing-signal precedence used by member
 * and constructor resolution paths. Add a new narrowing signal here once, not
 * at each call site.
 */
export const disambiguateByOverloadOrArgTypes = (
	pool: SymbolDefinition[],
	overloadHints: OverloadHints | undefined,
	preComputedArgTypes: (string | undefined)[] | undefined,
): SymbolDefinition | null => {
	if (!overloadHints && !preComputedArgTypes) return null;
	if (overloadHints) return tryOverloadDisambiguation(pool, overloadHints);
	if (preComputedArgTypes)
		return matchCandidatesByArgTypes(pool, preComputedArgTypes);
	return null;
};

export const orderProviderSameNameTypeCandidates = (
	candidates: readonly SymbolDefinition[],
	typeName: string,
	filePath: string,
): readonly SymbolDefinition[] | null => {
	const language = getLanguageFromFilename(filePath);
	if (language == null) return null;
	return (
		getProvider(language).orderSameNameTypeCandidates?.({
			typeName,
			callSiteFilePath: filePath,
			candidates,
		}) ?? null
	);
};

export const resolveProviderPrimaryTypeCandidate = (
	candidates: readonly SymbolDefinition[],
	tier: ResolutionTier,
	typeName: string,
	filePath: string,
): ResolveResult | null => {
	const ordered = orderProviderSameNameTypeCandidates(
		candidates,
		typeName,
		filePath,
	);
	return ordered && ordered.length > 0
		? toResolveResult(ordered[0], tier)
		: null;
};

/**
 * Thin dispatcher that routes a call to the appropriate specialized resolver.
 *
 * - `free`        → {@link resolveFreeCall}
 * - `constructor` → {@link resolveStaticCall}  (with pre-resolved tiered pool)
 * - `member` with a known receiver type → {@link resolveMemberCall}, with
 *   file-based fallback for traits/interfaces
 * - `member` without receiver type → module-alias check, then tiered lookup
 *
 * Replaces the former 200+ line function (SM-19: fuzzy-free call resolution).
 */
/**
 * Module-alias resolution for member calls without a receiver type.
 *
 * Handles Python/Ruby `import mod; mod.Symbol()` patterns where the receiver
 * is a module name, not a typed variable. Uses `moduleAliasMap` to scope
 * candidates to the correct module file.
 */
export const resolveModuleAliasedCall = (
	call: Pick<
		ExtractedCall,
		"calledName" | "argCount" | "callForm" | "receiverName"
	>,
	currentFile: string,
	ctx: ResolutionContext,
	widenCache?: WidenCache,
	tieredOverride?: TieredCandidates,
): ResolveResult | null => {
	if (!call.receiverName) return null;
	const aliasMap = ctx.moduleAliasMap?.get(currentFile);
	if (!aliasMap) return null;
	const moduleFile = aliasMap.get(call.receiverName);
	if (!moduleFile) return null;

	// Reuse the caller's pre-computed tiered result when available —
	// the dispatcher already called ctx.resolve(call.calledName, currentFile).
	const tiered = tieredOverride ?? ctx.resolve(call.calledName, currentFile);
	if (!tiered) return null;

	// Try member-form, then constructor-form (for `module.ClassName()` patterns)
	let filtered = filterCallableCandidates(
		tiered.candidates,
		call.argCount,
		call.callForm,
	).filter((c) => c.filePath === moduleFile);
	if (filtered.length === 0) {
		filtered = filterCallableCandidates(
			tiered.candidates,
			call.argCount,
			"constructor",
		).filter((c) => c.filePath === moduleFile);
	}
	if (filtered.length === 0) {
		// Widen to global callable+method indexes scoped to the aliased module
		// file. Function+ownerId (Python/Rust/Kotlin) is still routed to both
		// indexes until Unit 5 unblocks, so dedup by nodeId.
		const cacheKey = `${call.calledName}\0${moduleFile}`;
		let defs = widenCache?.get(cacheKey);
		if (!defs) {
			const rawCallable = ctx.model.symbols.lookupCallableByName(call.calledName);
			const rawMethods = ctx.model.methods.lookupMethodByName(call.calledName);
			const widenCombined: SymbolDefinition[] = [];
			const widenSeen = new Set<string>();
			for (const d of rawCallable) {
				if (widenSeen.has(d.nodeId)) continue;
				widenSeen.add(d.nodeId);
				widenCombined.push(d);
			}
			for (const d of rawMethods) {
				if (widenSeen.has(d.nodeId)) continue;
				widenSeen.add(d.nodeId);
				widenCombined.push(d);
			}
			defs = widenCombined;
			widenCache?.set(cacheKey, defs);
		}
		filtered = filterCallableCandidates(
			defs,
			call.argCount,
			call.callForm,
		).filter((c) => c.filePath === moduleFile);
		if (filtered.length === 0) {
			filtered = filterCallableCandidates(
				defs,
				call.argCount,
				"constructor",
			).filter((c) => c.filePath === moduleFile);
		}
	}
	return filtered.length === 1
		? toResolveResult(filtered[0], tiered.tier)
		: null;
};

/**
 * File-based fallback for member calls where owner-scoped resolution fails.
 *
 * Resolves the receiver type via `ctx.resolve()` and narrows all callable
 * symbols with the method name to the receiver type's defining file(s),
 * then applies ownerId filtering and overload disambiguation.
 *
 * Handles Rust trait dispatch (`repo.find()` where `find` is on a trait impl),
 * cross-file overloaded methods, and similar patterns where ownerId
 * relationships may not be established on all candidates.
 */
export const resolveMemberCallByFile = (
	calledName: string,
	receiverTypeName: string,
	currentFile: string,
	ctx: ResolutionContext,
	argCount?: number,
	callForm?: "free" | "member" | "constructor",
	overloadHints?: OverloadHints,
	preComputedArgTypes?: (string | undefined)[],
): ResolveResult | null => {
	const typeResolved = ctx.resolve(receiverTypeName, currentFile);
	if (!typeResolved || typeResolved.candidates.length === 0) return null;
	const typeNodeIds = new Set(typeResolved.candidates.map((d) => d.nodeId));
	const typeFiles = new Set(typeResolved.candidates.map((d) => d.filePath));

	// A4 (plan 006, Unit 4): consult both indexes. Strictly-labeled
	// Method/Constructor are disjoint, but Function+ownerId (Python/Rust/
	// Kotlin) is routed into BOTH indexes by `wrappedAdd` until Unit 5
	// unblocks — dedup by nodeId so overload disambiguation doesn't see
	// phantom duplicates.
	const rawCallablePool = ctx.model.symbols.lookupCallableByName(calledName);
	const rawMethodPool = ctx.model.methods.lookupMethodByName(calledName);
	const combinedPool: SymbolDefinition[] = [];
	const combinedSeen = new Set<string>();
	for (const def of rawCallablePool) {
		if (combinedSeen.has(def.nodeId)) continue;
		combinedSeen.add(def.nodeId);
		combinedPool.push(def);
	}
	for (const def of rawMethodPool) {
		if (combinedSeen.has(def.nodeId)) continue;
		combinedSeen.add(def.nodeId);
		combinedPool.push(def);
	}
	const methodPool = filterCallableCandidates(combinedPool, argCount, callForm);
	const fileFiltered = methodPool.filter((c) => typeFiles.has(c.filePath));
	if (fileFiltered.length === 1) {
		return toResolveResult(fileFiltered[0], typeResolved.tier);
	}

	// ownerId fallback: narrow by ownerId matching the type's nodeId
	const pool = fileFiltered.length > 0 ? fileFiltered : methodPool;
	const ownerFiltered = pool.filter(
		(c) => c.ownerId && typeNodeIds.has(c.ownerId),
	);
	if (ownerFiltered.length === 1)
		return toResolveResult(ownerFiltered[0], typeResolved.tier);

	// Overload disambiguation on the narrowed pool
	if (fileFiltered.length > 1 || ownerFiltered.length > 1) {
		const overloadPool = ownerFiltered.length > 1 ? ownerFiltered : fileFiltered;
		const disambiguated = disambiguateByOverloadOrArgTypes(
			overloadPool,
			overloadHints,
			preComputedArgTypes,
		);
		if (disambiguated) return toResolveResult(disambiguated, typeResolved.tier);
	}

	// Zero-match null-route: receiver type resolved but no candidate matched
	// after file-based and owner-based narrowing. Refuse to emit a CALLS edge
	// rather than guess — matches the SM-10 R3 null-route contract.
	return null;
};

/** Return the sole survivor from a tiered pool after callable + arity filtering, or null. */
export const singleCandidate = (
	tiered: TieredCandidates,
	argCount?: number,
	callForm?: "free" | "member" | "constructor",
): ResolveResult | null => {
	const filtered = filterCallableCandidates(
		tiered.candidates,
		argCount,
		callForm,
	);
	return filtered.length === 1
		? toResolveResult(filtered[0], tiered.tier)
		: null;
};

/** @internal Exported for unit tests. Do not use outside tests. */
