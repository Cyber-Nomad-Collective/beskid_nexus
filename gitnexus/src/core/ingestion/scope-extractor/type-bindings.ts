import type {
	CaptureMatch,
	ParsedImport,
	ScopeId,
	TypeRef,
} from "gitnexus-shared";
import type { buildPositionIndex, buildScopeTree } from "gitnexus-shared";
import type { ScopeDraft, ScopeExtractorHooks } from "./contracts.js";
import { draftToScope } from "./model.js";
import { anchorCaptureFor, rangesEqual } from "./references.js";

// ─── Pass 3: collect raw imports ───────────────────────────────────────────

export function pass3CollectImports(
	matches: readonly CaptureMatch[],
	parsedImports: ParsedImport[],
	provider: ScopeExtractorHooks,
): void {
	if (provider.interpretImport === undefined) return;
	for (const match of matches) {
		const anchor = anchorCaptureFor(match, "@import.");
		if (anchor === undefined) continue;
		const parsed = provider.interpretImport(match);
		if (parsed === null) continue;
		parsedImports.push(parsed);
	}
}

// ─── Pass 4: collect type bindings ─────────────────────────────────────────

export function pass4CollectTypeBindings(
	matches: readonly CaptureMatch[],
	drafts: readonly ScopeDraft[],
	positionIndex: ReturnType<typeof buildPositionIndex>,
	filePath: string,
	provider: ScopeExtractorHooks,
	scopeTree: ReturnType<typeof buildScopeTree>,
): void {
	const draftById = new Map<ScopeId, ScopeDraft>();
	for (const d of drafts) draftById.set(d.id, d);

	for (const match of matches) {
		const anchor = anchorCaptureFor(match, "@type-binding.");
		if (anchor === undefined) continue;

		const parsed = provider.interpretTypeBinding?.(match);
		if (parsed === null || parsed === undefined) continue;

		const innermostId = positionIndex.atPosition(
			filePath,
			anchor.range.startLine,
			anchor.range.startCol,
		);
		if (innermostId === undefined) continue;
		const innermost = draftById.get(innermostId);
		if (innermost === undefined) continue;

		// Auto-hoist for scope-creating type bindings (e.g. Python's
		// `@type-binding.return` whose anchor is the function_definition
		// itself). Same condition as Pass 2 — when the anchor coincides
		// with the innermost scope's range, the binding belongs in the
		// enclosing scope (callers, not the function body, look up the
		// return type by the function's name).
		const autoHostedId =
			innermost.parent !== null && rangesEqual(anchor.range, innermost.range)
				? innermost.parent
				: innermost.id;
		// `bindingScopeFor` may hoist the type binding to an outer scope.
		const hostId =
			provider.bindingScopeFor?.(match, draftToScope(innermost), scopeTree) ??
			autoHostedId;
		const host = draftById.get(hostId) ?? innermost;

		const typeRef: TypeRef = {
			rawName: parsed.rawTypeName,
			declaredAtScope: host.id,
			source: parsed.source,
		};
		// Prefer stronger sources when multiple matches fire for the same
		// bound name in the same scope. Example: `u: User = find()` matches
		// both the annotation and constructor-inferred patterns; the explicit
		// annotation (stronger source) must win over the call-site guess
		// regardless of query-match arrival order.
		const existing = host.typeBindings.get(parsed.boundName);
		if (
			existing === undefined ||
			typeBindingStrength(typeRef.source) >= typeBindingStrength(existing.source)
		) {
			host.typeBindings.set(parsed.boundName, typeRef);
		}
	}

	// ── Transitive closure over identifier-chain type bindings ─────────
	// Captures like `(assignment left: (ident) right: (ident))` emit a
	// TypeRef whose `rawName` is the RHS identifier. When the RHS name is
	// itself a bound variable with a known type in the same scope (or a
	// parent scope), follow the chain so `alias` ultimately points at the
	// class type — not at another local variable name. Without this,
	// `resolveTypeRef` hits the chained name, sees it's a local Variable
	// (non-type kind), and strict-returns null.
	for (const draft of drafts) {
		for (const [name, ref] of draft.typeBindings) {
			const resolved = followChainedRef(ref, draftById);
			if (resolved !== ref) draft.typeBindings.set(name, resolved);
		}
	}
}

/** Max chain depth: practical programs rarely exceed 4-5 re-bindings;
 *  the cap just prevents runaway loops when providers emit cycles. */
export const CHAIN_MAX_DEPTH = 16;

/**
 * Follow an identifier-chain TypeRef through successive typeBindings
 * lookups in the declaring scope and its ancestors. Returns the terminal
 * TypeRef (or the original if the chain dead-ends or cycles).
 */
export function followChainedRef(
	start: TypeRef,
	draftById: ReadonlyMap<ScopeId, ScopeDraft>,
): TypeRef {
	let current = start;
	const visited = new Set<string>();
	for (let depth = 0; depth < CHAIN_MAX_DEPTH; depth++) {
		// A rawName containing a dot (`models.User`) goes through
		// `QualifiedNameIndex` at resolution time — don't follow it here.
		if (current.rawName.includes(".")) return current;

		// Look up the current rawName in the declaring scope and walk up
		// the chain until we hit a scope that has a binding for it.
		let scopeId: ScopeId | null = current.declaredAtScope;
		let next: TypeRef | undefined;
		while (scopeId !== null) {
			const scope = draftById.get(scopeId);
			if (scope === undefined) break;
			next = scope.typeBindings.get(current.rawName);
			if (next !== undefined) break;
			scopeId = scope.parent;
		}

		if (next === undefined) return current; // dead end — nothing to chain to
		if (next === current) return current; // self-ref
		if (visited.has(next.rawName)) return current; // cycle guard
		visited.add(next.rawName);
		current = next;
	}
	return current;
}

/**
 * Priority ordering when multiple `TypeRef`s compete for the same bound
 * name in the same scope. Higher number wins; ties keep the later match
 * (last-write-wins preserves historical order within a tier).
 *
 * Rationale: explicit annotations always beat inferred ones because they
 * reflect user intent. `self`/`cls` are treated as strongly as annotations
 * because they are language-required receiver types.
 */
export function typeBindingStrength(source: TypeRef["source"]): number {
	switch (source) {
		case "annotation":
		case "parameter-annotation":
		case "return-annotation":
		case "self":
			return 2;
		case "assignment-inferred":
		case "constructor-inferred":
		case "receiver-propagated":
			return 1;
		default:
			return 0;
	}
}
