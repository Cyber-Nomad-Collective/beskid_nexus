import {
	CLASS_LIKE_TYPES,
	INSTANTIABLE_CLASS_TYPES,
	generateId,
	getLanguageFromFilename,
	getProvider,
	lookupMethodByOwnerWithMRO,
	receiverKey,
} from "./context.js";
import type {
	HeritageMap,
	KnowledgeGraph,
	ResolutionContext,
	ResolutionTier,
	SymbolDefinition,
	TieredCandidates,
} from "./context.js";
import type { ResolveResult } from "./type-inference.js";
import {
	disambiguateByOverloadOrArgTypes,
	filterCallableCandidates,
	matchCandidatesByArgTypes,
	orderProviderSameNameTypeCandidates,
	resolveProviderPrimaryTypeCandidate,
	toResolveResult,
	tryOverloadDisambiguation,
} from "./overload-path.js";
import type { OverloadHints } from "./overload-path.js";

export const extractFuncNameFromSourceId = (sourceId: string): string => {
	const lastColon = sourceId.lastIndexOf(":");
	const segment = lastColon >= 0 ? sourceId.slice(lastColon + 1) : "";
	const dotIdx = segment.lastIndexOf(".");
	const raw = dotIdx >= 0 ? segment.slice(dotIdx + 1) : segment;
	// Strip #<arity> suffix (e.g. "save#2" → "save")
	const hashIdx = raw.indexOf("#");
	return hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
};

/**
 * Build a composite key for receiver type storage.
 * Uses the full scope string (e.g. "save@100") to distinguish overloaded
 * methods with the same name in different classes.
 */
/**
 * Pre-built secondary index for O(1) receiver type lookups.
 * Built once per file from the verified receiver map, keyed by funcName → varName.
 */
type ReceiverTypeEntry =
	| { readonly kind: "resolved"; readonly value: string }
	| { readonly kind: "ambiguous" };
export type ReceiverTypeIndex = Map<string, Map<string, ReceiverTypeEntry>>;

/**
 * Build a two-level secondary index from the verified receiver map.
 * The verified map is keyed by `scope\0varName` where scope is either
 * "funcName@startIndex" (inside a function) or "" (file level).
 * Index structure: Map<funcName, Map<varName, ReceiverTypeEntry>>
 *
 * Known limitation: the index collapses scope keys to bare funcName,
 * so two same-arity overloads with the same local variable name but
 * different types will mark that variable as ambiguous. A future
 * enhancement should key by full scope (funcName@startIndex) and carry
 * scope keys through findEnclosingFunction's return type.
 */
export const buildReceiverTypeIndex = (
	map: Map<string, string>,
): ReceiverTypeIndex => {
	const index: ReceiverTypeIndex = new Map();
	for (const [key, typeName] of map) {
		const nul = key.indexOf("\0");
		if (nul < 0) continue;
		const scope = key.slice(0, nul);
		const varName = key.slice(nul + 1);
		if (!varName) continue;
		if (scope !== "" && !scope.includes("@")) continue;
		const funcName = scope === "" ? "" : scope.slice(0, scope.indexOf("@"));

		let varMap = index.get(funcName);
		if (!varMap) {
			varMap = new Map();
			index.set(funcName, varMap);
		}

		const existing = varMap.get(varName);
		if (existing === undefined) {
			varMap.set(varName, { kind: "resolved", value: typeName });
		} else if (existing.kind === "resolved" && existing.value !== typeName) {
			varMap.set(varName, { kind: "ambiguous" });
		}
	}
	return index;
};

/**
 * O(1) receiver type lookup using the pre-built secondary index.
 * Returns the unique type name if unambiguous. Falls back to file-level scope.
 */
export const lookupReceiverType = (
	index: ReceiverTypeIndex,
	funcName: string,
	varName: string,
): string | undefined => {
	const funcBucket = index.get(funcName);
	if (funcBucket) {
		const entry = funcBucket.get(varName);
		if (entry?.kind === "resolved") return entry.value;
		if (entry?.kind === "ambiguous") {
			// Ambiguous in this function scope — try file-level fallback
			const fileEntry = index.get("")?.get(varName);
			return fileEntry?.kind === "resolved" ? fileEntry.value : undefined;
		}
	}
	// Fallback: file-level scope (funcName "")
	if (funcName !== "") {
		const fileEntry = index.get("")?.get(varName);
		if (fileEntry?.kind === "resolved") return fileEntry.value;
	}
	return undefined;
};

/**
 * Resolve a method by owner type name using the eagerly-populated methodByOwner index.
 * Returns `{ def, tier }` when an unambiguous method is found, `undefined` otherwise.
 *
 * **Multi-candidate iteration (homonym disambiguation):** when `ctx.resolve(ownerType)`
 * returns multiple class-like candidates (e.g. two classes named `User` in different
 * files reachable from the call site), each is probed with `lookupMethodByOwnerWithMRO`.
 * Results are deduplicated by `nodeId` so that:
 *
 *   - homonym classes that both walk up to the SAME ancestor's method collapse to 1 hit
 *   - aliased re-exports that produce two candidates pointing at the same def collapse too
 *
 * After deduplication:
 *
 *   - 0 unique matches → `undefined` (owner-scoped path has no answer)
 *   - 1 unique match   → return it
 *   - ≥2 unique matches → `undefined` (genuine homonym ambiguity; don't silently pick one)
 *
 * The returned `tier` reflects how the owner TYPE was resolved (not the method name).
 * Threaded out here so callers don't need a second `ctx.resolve(ownerType, ...)` call —
 * this decouples callers from `ctx.resolve`'s per-file caching contract.
 */
export const resolveMethodByOwner = (
	receiverTypeName: string,
	methodName: string,
	filePath: string,
	ctx: ResolutionContext,
	heritageMap?: HeritageMap,
	argCount?: number,
	/**
	 * DAG-sourced ancestry selector. `'singleton'` routes through
	 * `heritageMap.getSingletonAncestry(owner)` for class-method dispatch
	 * (Ruby `Account.log` via `extend LoggerMixin`). Default / undefined
	 * uses the walker's instance-dispatch behavior.
	 */
	ancestryView?: "instance" | "singleton",
): { def: SymbolDefinition; tier: ResolutionTier } | undefined => {
	const typeResolved = ctx.resolve(receiverTypeName, filePath);
	if (!typeResolved) return undefined;

	// MRO walking needs a language hint so we can derive the per-language
	// strategy; compute it once and reuse for every candidate. Unknown
	// extension → fall back to plain direct lookup (D1-D4 still runs on miss).
	const language = heritageMap ? getLanguageFromFilename(filePath) : null;
	const mroStrategy =
		language != null ? getProvider(language).mroStrategy : null;
	const canWalkMRO = heritageMap != null && mroStrategy != null;

	// Iterate all class-like candidates tracking the first unambiguous hit.
	// Zero-allocation fast path: the common case is exactly one class candidate,
	// so we avoid building a Map. A second hit with a different `nodeId` flips
	// `ambiguous` and short-circuits the loop. Diamond MRO convergence on the
	// same inherited method collapses to one hit because `nodeId` matches.
	//
	//   firstDef === undefined → owner-scoped resolution found nothing
	//   firstDef && !ambiguous → unambiguous answer
	//   ambiguous              → genuine homonym ambiguity — refuse to pick
	//
	// argCount is threaded through so arity-differing overloads
	// (e.g. C++ `greet()` vs `greet(string)`) are disambiguated inside the
	// owner-scoped lookup rather than collapsing to an arbitrary first pick.
	let firstDef: SymbolDefinition | undefined;
	let ambiguous = false;
	for (const candidate of typeResolved.candidates) {
		if (!CLASS_LIKE_TYPES.has(candidate.type)) continue;
		// Singleton dispatch: when the DAG decision requested the singleton
		// ancestry view, pass `heritageMap.getSingletonAncestry` as the walker's
		// ancestry override. Kind-aware strategies (e.g. MroStrategy 'ruby-mixin')
		// honor the override by scanning it linearly in place of their default walk.
		const singletonOverride =
			ancestryView === "singleton" && canWalkMRO && heritageMap
				? heritageMap.getSingletonAncestry(candidate.nodeId).map((e) => e.parentId)
				: undefined;
		const def = canWalkMRO
			? lookupMethodByOwnerWithMRO(
					candidate.nodeId,
					methodName,
					heritageMap,
					ctx.model,
					mroStrategy,
					argCount,
					singletonOverride,
				)
			: ctx.model.methods.lookupMethodByOwner(
					candidate.nodeId,
					methodName,
					argCount,
				);
		if (!def) continue;
		if (!firstDef) {
			firstDef = def;
		} else if (def.nodeId !== firstDef.nodeId) {
			ambiguous = true;
			break;
		}
	}

	if (!firstDef && !ambiguous) {
		const orderedTypeCandidates = orderProviderSameNameTypeCandidates(
			ctx.model.types.lookupClassByName(receiverTypeName),
			receiverTypeName,
			filePath,
		);
		if (orderedTypeCandidates) {
			for (const candidate of orderedTypeCandidates) {
				const def = canWalkMRO
					? lookupMethodByOwnerWithMRO(
							candidate.nodeId,
							methodName,
							heritageMap,
							ctx.model,
							mroStrategy,
							argCount,
						)
					: ctx.model.methods.lookupMethodByOwner(
							candidate.nodeId,
							methodName,
							argCount,
						);
				if (!def) continue;
				if (!firstDef) {
					firstDef = def;
				} else if (def.nodeId !== firstDef.nodeId) {
					ambiguous = true;
					break;
				}
			}
		}
	}

	if (!firstDef || ambiguous) return undefined;
	return { def: firstDef, tier: typeResolved.tier };
};

// ---------------------------------------------------------------------------
// SM-11: Owner-scoped + MRO member-call resolution (no fuzzy lookup)
// ---------------------------------------------------------------------------

/**
 * Resolve a member call using owner-scoped + MRO resolution only (no fuzzy lookup).
 * Used for `obj.method()` calls where the receiver type is known.
 *
 * Delegates to {@link resolveMethodByOwner} which performs an O(1) owner-scoped
 * method lookup and, when a {@link HeritageMap} is provided, walks the MRO chain
 * via {@link lookupMethodByOwnerWithMRO}.
 *
 * {@link resolveCallTarget} delegates here for member calls.
 *
 * **SEMANTIC CHANGE (2026-04-09):** The confidence tier reflects how the
 * owner TYPE was resolved, not how the method NAME was resolved globally.
 * more accurate for owner-scoped resolution (the discriminant IS the class,
 * not the method name). Downstream consumers that filter CALLS edges by
 * confidence threshold may see shifted values on otherwise-unchanged code.
 * See the "returns result with correct confidence tier" tests below for the
 * locked-in behavior.
 *
 * **Performance:** Callers that only need the return type (e.g. `walkMixedChain`)
 * should call {@link resolveMethodByOwner} directly and use the `.def.returnType`
 * field instead, to avoid building a throwaway `ResolveResult`.
 *
 * @param ownerType   - The receiver's type name (e.g. 'User')
 * @param methodName  - The method being called (e.g. 'save')
 * @param currentFile - File path of the call site
 * @param ctx         - Resolution context
 * @param heritageMap - Optional heritage map for MRO-aware ancestor walking
 */
export const resolveMemberCall = (
	ownerType: string,
	methodName: string,
	currentFile: string,
	ctx: ResolutionContext,
	heritageMap?: HeritageMap,
	argCount?: number,
	ancestryView?: "instance" | "singleton",
): ResolveResult | null => {
	const resolved = resolveMethodByOwner(
		ownerType,
		methodName,
		currentFile,
		ctx,
		heritageMap,
		argCount,
		ancestryView,
	);
	if (!resolved) return null;
	return toResolveResult(resolved.def, resolved.tier);
};

// ---------------------------------------------------------------------------
// SM-13: Free-function call resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a free-function call using `lookupExact` (same-file) + import-scoped
 * resolution via `ctx.resolve()`.
 *
 * Used for `foo()`, `doStuff()` — unqualified calls with no receiver.
 * Also handles implicit constructors (`User()` without `new`) by delegating
 * to {@link resolveStaticCall} when the tiered pool contains class-like
 * targets.
 *
 * {@link resolveCallTarget} delegates here for `callForm === 'free'`.
 *
 * `resolveFreeCall` does not take a `widenCache` parameter. Free calls
 * have no receiver type and rely exclusively on the tiered pool
 * from `ctx.resolve()`.
 *
 * @param calledName  - The called function name (e.g. 'doStuff')
 * @param filePath    - File path of the call site
 * @param ctx         - Resolution context
 * @param argCount    - Optional argument count for arity filtering
 * @param tieredOverride - Pre-computed tiered candidates from an upstream
 *                       `ctx.resolve` call. When provided, skips the redundant
 *                       lookup inside this function.
 * @param overloadHints  - Optional AST-based overload disambiguation hints
 * @param preComputedArgTypes - Optional pre-computed argument types (worker path)
 */
export const resolveFreeCall = (
	calledName: string,
	filePath: string,
	ctx: ResolutionContext,
	argCount?: number,
	tieredOverride?: TieredCandidates,
	overloadHints?: OverloadHints,
	preComputedArgTypes?: (string | undefined)[],
): ResolveResult | null => {
	const tiered = tieredOverride ?? ctx.resolve(calledName, filePath);
	if (!tiered) return null;

	let filteredCandidates = filterCallableCandidates(
		tiered.candidates,
		argCount,
		"free",
	);

	// Class-target fast path: free-form call targeting a class. Delegates to
	// resolveStaticCall for O(1) class + constructor lookup.
	// The `.some()` trigger must stay aligned with `INSTANTIABLE_CLASS_TYPES` —
	// any type admitted here that is not in that set will cause resolveStaticCall
	// to return null, wasting two lookup passes per call. `Enum` is deliberately
	// excluded; `Record` is included so record-like class targets reach the fast
	// path.
	// Align with INSTANTIABLE_CLASS_TYPES by reusing the set directly rather
	// than enumerating literal strings. This converts an invariant that was
	// previously enforced by a comment ("keep this list aligned with
	// INSTANTIABLE_CLASS_TYPES") into one enforced structurally — any future
	// extension of the set propagates here automatically.
	// Language providers can still choose a primary same-name type candidate in
	// the tail of this function when their grammars index one logical type
	// multiple times.
	const hasClassTarget =
		filteredCandidates.length === 0 &&
		tiered.candidates.some((c) => INSTANTIABLE_CLASS_TYPES.has(c.type));
	if (hasClassTarget) {
		const staticResult = resolveStaticCall(
			calledName,
			filePath,
			ctx,
			argCount,
			tiered,
		);
		if (staticResult) return staticResult;
		// Retry with constructor form for languages whose constructor calls look
		// like free function calls. If resolveStaticCall didn't match, re-filter
		// with constructor form so CONSTRUCTOR_TARGET_TYPES applies.
		//
		// The retry fires for every null return from `resolveStaticCall`, which
		// can happen for three distinct reasons — all three are handled below:
		//
		//   (a) No explicit `Constructor` node found and zero instantiable
		//       class candidates (e.g. Interface/Trait/Impl only — the SM-12
		//       null-route contract). `filterCallableCandidates` with
		//       `'constructor'` form will also return nothing → we fall
		//       through to the final null return. Correct.
		//
		//   (b) Homonym ambiguity — two or more instantiable class candidates
		//       share the name (e.g. `User` in two files, same tier). The
		//       retry repopulates `filteredCandidates` with both Classes and
		//       they flow into the provider same-name candidate hook below, which
		//       can pick a primary definition or null-route.
		//
		//   (c) `resolveStaticCall` step 4 bailed because the tiered pool
		//       contains ownerless `Constructor` nodes (some extractors emit
		//       constructors without `ownerId`). Those `Constructor` nodes
		//       survive the constructor-form filter below and reach overload
		//       disambiguation, giving the existing filter path a chance to
		//       pick the right one. Correct but currently uncovered by a
		//       dedicated test — the R5 `preComputedArgTypes` path exercises
		//       overload disambiguation for Functions, which is structurally
		//       the same code.
		filteredCandidates = filterCallableCandidates(
			tiered.candidates,
			argCount,
			"constructor",
		);
	}

	// E. Overload disambiguation
	if (filteredCandidates.length > 1) {
		const disambiguated = overloadHints
			? tryOverloadDisambiguation(filteredCandidates, overloadHints)
			: preComputedArgTypes
				? matchCandidatesByArgTypes(filteredCandidates, preComputedArgTypes)
				: null;
		if (disambiguated) return toResolveResult(disambiguated, tiered.tier);
	}

	if (filteredCandidates.length !== 1) {
		const primary = resolveProviderPrimaryTypeCandidate(
			filteredCandidates,
			tiered.tier,
			calledName,
			filePath,
		);
		if (primary) return primary;
		return null;
	}

	return toResolveResult(filteredCandidates[0], tiered.tier);
};

// ---------------------------------------------------------------------------
// SM-12: Constructor/static call resolution (no fuzzy lookup)
// ---------------------------------------------------------------------------

/**
 * Resolve a constructor or static call using class-scoped lookup (no fuzzy lookup).
 * Used for `new User()` / `User()` calls where the calledName targets a class.
 *
 * Uses {@link TypeRegistry.lookupClassByName} for O(1) class lookup and
 * {@link MethodRegistry.lookupMethodByOwner} for constructor resolution.
 * {@link resolveCallTarget} delegates here for constructor and free-form calls
 * that target a class.
 *
 * Resolution strategy:
 *   1. `lookupClassByName(className)` — O(1) pre-check; bail early if no class exists.
 *   2. `ctx.resolve(className, currentFile)` — import-scoped tier for confidence.
 *   3. Filter to class-like candidates via `CLASS_LIKE_TYPES` and walk each
 *      with `lookupMethodByOwner(classNodeId, className, argCount)` — O(1)
 *      constructor lookup. Only accept results with `type === 'Constructor'`.
 *   4. If step 3 found nothing and the tiered pool contains ownerless
 *      `Constructor` nodes (common in some extractors), bail out so
 *      `filterCallableCandidates` downstream handles Constructor-vs-Class
 *      preference correctly.
 *   5. Class-node fallback: filter `classCandidates` through
 *      `INSTANTIABLE_CLASS_TYPES` and return the sole survivor when there is
 *      exactly one. Null-route on zero survivors (Interface / Trait / Impl
 *      stripped) or multiple (homonym ambiguity).
 *
 * @param className   - The class name (e.g. 'User'). Also used as the method
 *                       name for the `lookupMethodByOwner` scan, because the
 *                       only constructor-shaped call we handle today is
 *                       `ClassName(...)` / `new ClassName(...)`. Named
 *                       constructors like Dart `User.fromJson()` arrive as
 *                       member calls and route through `resolveMemberCall`,
 *                       so this function does not yet need a separate
 *                       `methodName` parameter. Revisit if a language surfaces
 *                       a static-method-shaped call with a distinct member
 *                       name.
 * @param currentFile - File path of the call site
 * @param ctx         - Resolution context
 * @param argCount    - Optional argument count for arity filtering
 * @param tieredOverride - Pre-computed tiered candidates for `className` from
 *                       an upstream `ctx.resolve` call. When provided, skips
 *                       the redundant lookup inside this function. Leave
 *                       unset for direct callers without a prior resolution.
 */
export const resolveStaticCall = (
	className: string,
	currentFile: string,
	ctx: ResolutionContext,
	argCount?: number,
	tieredOverride?: TieredCandidates,
	overloadHints?: OverloadHints,
	preComputedArgTypes?: (string | undefined)[],
): ResolveResult | null => {
	// 1. Pre-check: does a class with this name exist at all? (O(1))
	//    This guards against the expensive `ctx.resolve` walk when the name
	//    is clearly not class-like (e.g. plain functions). When `tieredOverride`
	//    is supplied, the caller has already paid for the tiered lookup, so this
	//    pre-check still prevents the class-candidate filter + lookupMethodByOwner
	//    loop from running on obviously non-class targets.
	const allClasses = ctx.model.types.lookupClassByName(className);
	if (allClasses.length === 0) return null;

	// 2. Scope via ctx.resolve for import-tier information. Reuse the caller's
	//    tiered result when provided — it is computed from the same name and
	//    file context, so re-running the walk would be a pure waste.
	const typeResolved = tieredOverride ?? ctx.resolve(className, currentFile);
	if (!typeResolved) return null;

	const classCandidates = typeResolved.candidates.filter((c) =>
		CLASS_LIKE_TYPES.has(c.type),
	);
	if (classCandidates.length === 0) return null;

	// 3. Try lookupMethodByOwner for explicit Constructor nodes.
	//    Only accept results with type === 'Constructor' — a Method or Function
	//    that happens to share the class name (e.g. C++ methods named after
	//    their class) is not a constructor for resolution purposes.
	//    Same dedup logic as resolveMethodByOwner: diamond inheritance converging
	//    on the same constructor collapses to one hit.
	//
	//    Same-name assumption: the lookup key is `${candidate.nodeId}\0${className}`,
	//    so this finds Constructor nodes whose symbol name equals the class name
	//    (`class User` with a `Constructor` named `User`). Constructors indexed
	//    under a different name (e.g. Python `__init__`) will not be found here —
	//    but they also won't appear in the tiered pool for `ctx.resolve(className)`
	//    for the same reason, so step 4's Constructor-presence check will not
	//    see them either. The two miss cases are symmetric. If a future extractor
	//    indexes Constructor nodes under an alternative name while still setting
	//    `ownerId`, this assumption will need revisiting.
	let firstDef: SymbolDefinition | undefined;
	let ambiguous = false;
	for (const candidate of classCandidates) {
		const def = ctx.model.methods.lookupMethodByOwner(
			candidate.nodeId,
			className,
			argCount,
		);
		if (def?.type !== "Constructor") continue;
		if (!firstDef) {
			firstDef = def;
		} else if (def.nodeId !== firstDef.nodeId) {
			ambiguous = true;
			break;
		}
	}

	if (firstDef && !ambiguous) {
		return toResolveResult(firstDef, typeResolved.tier);
	}

	// 4. lookupMethodByOwner found nothing — check whether the tiered pool
	//    contains Constructor nodes that lack ownerId (common in some extractors).
	//    If so, bail out so the existing filterCallableCandidates path handles
	//    Constructor-vs-Class preference correctly.
	//
	//    This branch also catches the step-3 ambiguous case (`ambiguous = true`
	//    with two distinct Constructor nodes across multiple class candidates):
	//    the same Constructor nodes are indexed under the class name in the
	//    tiered pool, so `.some(Constructor)` is true here and we defer to
	//    step 4.5 (overload/arg-type disambiguation) or the caller's fallback.
	//    Do not remove this check without also handling the ambiguous step-3
	//    path explicitly.
	if (typeResolved.candidates.some((c) => c.type === "Constructor")) {
		// 4.5. Overload / arg-type disambiguation for ambiguous or ownerless
		//      Constructor pools. When the caller supplied a narrowing signal
		//      (AST-based overload hints from the sequential path, or pre-
		//      computed arg types from the worker path), give disambiguation a
		//      chance before null-routing. Symmetric with resolveMemberCallByFile's
		//      disambiguation pass — both resolvers now share the same signal
		//      precedence via disambiguateByOverloadOrArgTypes. Only fires when
		//      at least one narrowing signal is present; preserves SM-10 R3 for
		//      genuinely ambiguous cases with no disambiguating input.
		if (overloadHints || preComputedArgTypes) {
			const ctorPool = filterCallableCandidates(
				typeResolved.candidates,
				argCount,
				"constructor",
			);
			if (ctorPool.length > 1) {
				const disambiguated = disambiguateByOverloadOrArgTypes(
					ctorPool,
					overloadHints,
					preComputedArgTypes,
				);
				if (disambiguated) return toResolveResult(disambiguated, typeResolved.tier);
			}
		}
		return null;
	}

	// 5. No constructor nodes at all — fall back to the class node itself, but
	//    ONLY when it is actually instantiable. Interface / Trait / Impl / Enum
	//    are deliberately excluded via `INSTANTIABLE_CLASS_TYPES` to prevent
	//    false `CALLS` edges from constructor-shaped calls to non-instantiable
	//    nodes. This also disambiguates the Rust same-file shadowing case
	//    (`struct User` + `impl User` both present at same-file tier): the
	//    Impl is stripped, leaving the Struct as the sole instantiable target.
	//    Addresses Codex review finding on PR #754.
	const instantiableCandidates = classCandidates.filter((c) =>
		INSTANTIABLE_CLASS_TYPES.has(c.type),
	);
	// Three outcomes below, in order of likelihood after the fix:
	//   length === 0 → all candidates were stripped as non-instantiable (e.g.
	//     Interface / Trait / Impl). Null-route via the fall-through `return
	//     null` — this is the dominant Codex-fix case.
	//   length === 1 → a single instantiable candidate remains, return it.
	//   length  >  1 → let the call-site provider choose a primary when it can
	//     prove the candidates are one logical type; otherwise null-route.
	const primary = resolveProviderPrimaryTypeCandidate(
		instantiableCandidates,
		typeResolved.tier,
		className,
		currentFile,
	);
	if (primary) return primary;

	if (instantiableCandidates.length === 1) {
		return toResolveResult(instantiableCandidates[0], typeResolved.tier);
	}

	return null;
};

/**
 * Create a deduplicated ACCESSES edge emitter for a single source node.
 * Each (sourceId, fieldNodeId) pair is emitted at most once per source.
 */
export type OnFieldResolved = (fieldNodeId: string) => void;

export const makeAccessEmitter = (
	graph: KnowledgeGraph,
	sourceId: string,
): OnFieldResolved => {
	const emitted = new Set<string>();
	return (fieldNodeId: string): void => {
		const key = `${sourceId}\0${fieldNodeId}`;
		if (emitted.has(key)) return;
		emitted.add(key);

		graph.addRelationship({
			id: generateId("ACCESSES", `${sourceId}:${fieldNodeId}:read`),
			sourceId,
			targetId: fieldNodeId,
			type: "ACCESSES",
			confidence: 1.0,
			reason: "read",
		});
	};
};

/**
 * Walk a pre-built mixed chain of field/call steps, threading the current type
 * through each step and returning the final resolved type.
 *
 * Returns `undefined` if any step cannot be resolved (chain is broken).
 * The caller is responsible for seeding `startType` from its own context
 * (TypeEnv, constructor bindings, or static-class fallback).
 */
/**
 * Fast path: resolve pre-extracted call sites from workers.
 * No AST parsing — workers already extracted calledName + sourceId.
 *
 * @param bindingAccumulator  Phase 9: optional accumulator carrying file-scope
 *   TypeEnv bindings from all worker-processed files. When the SymbolTable has
 *   no return type for a cross-file callee, `verifyConstructorBindings` falls
 *   back to the accumulator via `namedImportMap` to bind the variable to the
 *   callee's resolved type (e.g. `var x = getUser()` → `x: User`).
 */
