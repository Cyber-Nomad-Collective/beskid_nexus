import { defaultDispatchDecision } from "./context.js";
import type {
	DispatchDecision,
	ExtractedCall,
	HeritageMap,
	ResolutionContext,
} from "./context.js";
import type { ResolveResult } from "./type-inference.js";
import {
	countCallableCandidates,
	resolveMemberCallByFile,
	resolveModuleAliasedCall,
	singleCandidate,
} from "./overload-path.js";
import type { OverloadHints, WidenCache } from "./overload-path.js";
import {
	resolveFreeCall,
	resolveMemberCall,
	resolveStaticCall,
} from "./receiver-member.js";

export const _resolveCallTargetForTesting = (
	call: Pick<
		ExtractedCall,
		"calledName" | "argCount" | "callForm" | "receiverTypeName" | "receiverName"
	>,
	currentFile: string,
	ctx: ResolutionContext,
	opts?: {
		overloadHints?: OverloadHints;
		widenCache?: WidenCache;
		preComputedArgTypes?: (string | undefined)[];
		heritageMap?: HeritageMap;
	},
): ResolveResult | null =>
	resolveCallTarget(
		call,
		currentFile,
		ctx,
		opts?.overloadHints,
		opts?.widenCache,
		opts?.preComputedArgTypes,
		opts?.heritageMap,
	);

export const resolveCallTarget = (
	call: Pick<
		ExtractedCall,
		"calledName" | "argCount" | "callForm" | "receiverTypeName" | "receiverName"
	>,
	currentFile: string,
	ctx: ResolutionContext,
	overloadHints?: OverloadHints,
	widenCache?: WidenCache,
	preComputedArgTypes?: (string | undefined)[],
	heritageMap?: HeritageMap,
	dispatchDecision?: DispatchDecision,
): ResolveResult | null => {
	const tiered = ctx.resolve(call.calledName, currentFile);
	if (!tiered) return null;

	// DAG dispatch: use decision.primary to pick the resolver branch.
	// Callers that own the DAG (processCalls + crossFile deferred paths)
	// pass a decision; other callers use the shared default ladder.
	// Language-specific primary / fallback / ancestryView overrides come from
	// the provider's `selectDispatch` hook.
	const decision = dispatchDecision ?? defaultDispatchDecision(call.callForm);
	const primary = decision.primary;

	if (primary === "free") {
		return resolveFreeCall(
			call.calledName,
			currentFile,
			ctx,
			call.argCount,
			tiered,
			overloadHints,
			preComputedArgTypes,
		);
	}
	if (primary === "constructor") {
		return (
			resolveStaticCall(
				call.calledName,
				currentFile,
				ctx,
				call.argCount,
				tiered,
				overloadHints,
				preComputedArgTypes,
			) ?? singleCandidate(tiered, call.argCount, "constructor")
		);
	}
	// primary === 'owner-scoped'
	if (call.receiverTypeName) {
		// Skip the owner-scoped MRO path when the tiered pool has genuine
		// overload ambiguity that needs D1-D4+E handling, not D0.
		const skipMember =
			(!!overloadHints || !!preComputedArgTypes) &&
			countCallableCandidates(tiered.candidates, call.argCount, call.callForm) > 1;
		// Try owner-scoped (resolveMemberCall) then file-scoped (resolveMemberCallByFile).
		// DAG: dispatchDecision.ancestryView selects instance vs singleton ancestry
		// for kind-aware MRO strategies. Ruby `Account.log` flows via 'singleton'.
		//
		// Singleton-ancestry miss MUST NOT degrade to the file-scoped fallback:
		// resolveMemberCallByFile matches by ownerId and would happily pick an
		// instance method defined on the same class, leaking instance dispatch
		// onto what was declared a class-method call. For singleton dispatch,
		// a miss either null-routes or falls through to `decision.fallback`.
		const singletonDispatch = decision.ancestryView === "singleton";
		const memberResult =
			(!skipMember
				? resolveMemberCall(
						call.receiverTypeName,
						call.calledName,
						currentFile,
						ctx,
						heritageMap,
						call.argCount,
						decision.ancestryView,
					)
				: null) ??
			(singletonDispatch
				? null
				: resolveMemberCallByFile(
						call.calledName,
						call.receiverTypeName,
						currentFile,
						ctx,
						call.argCount,
						call.callForm,
						overloadHints,
						preComputedArgTypes,
					));
		if (memberResult) return memberResult;

		// Module-alias narrowing runs as a FALLBACK, after owner/file-scoped
		// resolvers have returned null. This ordering is load-bearing: placing
		// alias narrowing first would short-circuit unique owner-scoped answers
		// when a local variable coincidentally matches an alias name, leaking
		// unrelated homonyms from the aliased file onto the wrong receiver type.
		//
		// The type-file verification guard is load-bearing for SM-10 R3: an
		// alias is only a VALID narrowing signal when the alias target file is
		// among the receiver type's defining files. If the alias points at a
		// file that does not hold `receiverTypeName`, any candidate we would
		// pick from there would belong to an unrelated class — a cross-type
		// false positive. ctx.resolve is cached per (name, file), so resolving
		// the receiver type a second time here is free.
		const typeResolves = ctx.resolve(call.receiverTypeName, currentFile);
		const aliasMap = ctx.moduleAliasMap?.get(currentFile);
		const aliasTargetFile =
			call.receiverName && aliasMap ? aliasMap.get(call.receiverName) : undefined;
		if (
			aliasTargetFile &&
			typeResolves?.candidates.some((c) => c.filePath === aliasTargetFile)
		) {
			const aliasResult = resolveModuleAliasedCall(
				call,
				currentFile,
				ctx,
				widenCache,
				tiered,
			);
			if (aliasResult) return aliasResult;
		}

		// SM-10 R3 null-route: when the receiver type resolves to indexed types
		// but no scoped resolver (nor the guarded alias fallback) produced a
		// match, that's a genuine miss — refuse to emit a CALLS edge rather
		// than guess via an unscoped singleCandidate that ignores the class
		// hierarchy. When the type is NOT in the index (PHP `mixed`, dynamic
		// types, unresolvable aliases), the scoped resolvers had nothing to
		// work with and singleCandidate is the correct last resort.
		//
		// DAG fallback override: when `select-dispatch` returned
		// `fallback: 'free-arity-narrowed'` (today: Ruby implicit-self bare
		// calls whose enclosing class doesn't define the method), fall through
		// to free-call resolution instead of null-routing. This preserves
		// existing free-call arity-narrowing heuristics for bare calls that
		// happen to target methods on unrelated classes.
		if (typeResolves && typeResolves.candidates.length > 0) {
			if (decision.fallback === "free-arity-narrowed") {
				const free = resolveFreeCall(
					call.calledName,
					currentFile,
					ctx,
					call.argCount,
					tiered,
					overloadHints,
					preComputedArgTypes,
				);
				if (free) return free;
			}
			return null; // null-route: type resolved, no candidate matched
		}
		return singleCandidate(tiered, call.argCount, call.callForm);
	}
	// Member call with no inferred receiver type — e.g. Python `mod.fn()`
	// where `mod` is a module alias. Module-alias narrowing is the primary
	// disambiguation signal here. Also consulted from the typed-member
	// branch above as a guarded fallback after owner/file-scoped resolvers.
	return (
		resolveModuleAliasedCall(call, currentFile, ctx, widenCache, tiered) ??
		singleCandidate(tiered, call.argCount, call.callForm)
	);
};

// ── Scope key helpers ────────────────────────────────────────────────────
// Scope keys use the format "funcName@startIndex" (produced by type-env.ts).
// Source IDs use "Label:filepath:funcName" (produced by parse-worker.ts).
// NUL (\0) is used as a composite-key separator because it cannot appear
// in source-code identifiers, preventing ambiguous concatenation.
//
// receiverKey stores the FULL scope (funcName@startIndex) to prevent
// collisions between overloaded methods with the same name in different
// classes (e.g. User.save@100 and Repo.save@200 are distinct keys).
// Lookup uses a secondary funcName-only index built in lookupReceiverType.

/** Extract the bare function name from a sourceId.
 *  Handles both unqualified ("Function:filepath:funcName" → "funcName")
 *  and qualified ("Function:filepath:ClassName.funcName" → "funcName").
 *  Strips any trailing #<arity> suffix from Method/Constructor IDs. */
