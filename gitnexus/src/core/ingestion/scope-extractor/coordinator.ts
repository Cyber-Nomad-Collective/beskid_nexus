import type {
	CaptureMatch,
	ParsedFile,
	ParsedImport,
	ReferenceSite,
	SymbolDefinition,
} from "gitnexus-shared";
import { buildPositionIndex, buildScopeTree } from "gitnexus-shared";
import type { ScopeExtractorHooks } from "./contracts.js";
import { pass2AttachDeclarations } from "./declarations.js";
import { pass1BuildScopes } from "./hierarchy.js";
import { draftToScope, ensureModuleScope } from "./model.js";
import { partitionByTopic } from "./partition.js";
import { pass5CollectReferences } from "./references.js";
import {
	pass3CollectImports,
	pass4CollectTypeBindings,
} from "./type-bindings.js";

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Drive the five extraction passes and return a `ParsedFile`.
 *
 * Throws `ScopeTreeInvariantError` (from #912) when the provider emits
 * captures that violate structural scope invariants. The error surfaces
 * upward rather than being silently corrected — a malformed capture set
 * is a bug in the provider's `emitScopeCaptures`, not a data condition
 * to tolerate.
 */
export function extract(
	matches: readonly CaptureMatch[],
	filePath: string,
	provider: ScopeExtractorHooks,
): ParsedFile {
	// Partition matches by topic up front — one linear pass over the input.
	const partitioned = partitionByTopic(matches);

	// ── Pass 1: build the scope tree ─────────────────────────────────────
	const scopeDrafts = pass1BuildScopes(partitioned.scope, filePath, provider);
	const moduleScope = ensureModuleScope(scopeDrafts, matches.length, filePath);
	const scopes = scopeDrafts.map(draftToScope);
	// buildScopeTree validates invariants (throws on violation) and exposes
	// the lookup contract consumed by Passes 2-5.
	//
	// **Snapshot semantics.** Both `scopeTree` and `positionIndex` are built
	// from the post-Pass-1 `scopes` — parent/range/kind are accurate, but
	// `bindings`, `ownedDefs`, and `typeBindings` are all empty here. Later
	// passes write into the *drafts*, not into these snapshots; any hook
	// that reads `scope.bindings` etc. via the `scopeTree` argument sees a
	// structural view only. This is by design — hooks use scopeTree for
	// "what's the parent chain?" queries, not for content queries.
	const scopeTree = buildScopeTree(scopes);
	const positionIndex = buildPositionIndex(scopes);

	// ── Pass 2: attach declarations + local bindings ────────────────────
	const localDefs: SymbolDefinition[] = [];
	pass2AttachDeclarations(
		partitioned.declaration,
		scopeDrafts,
		positionIndex,
		localDefs,
		filePath,
		provider,
		scopeTree,
	);

	// ── Pass 3: collect raw imports ─────────────────────────────────────
	const parsedImports: ParsedImport[] = [];
	pass3CollectImports(partitioned.import_, parsedImports, provider);

	// ── Pass 4: collect type bindings ───────────────────────────────────
	pass4CollectTypeBindings(
		partitioned.typeBinding,
		scopeDrafts,
		positionIndex,
		filePath,
		provider,
		scopeTree,
	);

	// ── Pass 5: collect reference sites ─────────────────────────────────
	const referenceSites: ReferenceSite[] = [];
	pass5CollectReferences(
		partitioned.reference,
		positionIndex,
		filePath,
		referenceSites,
		provider,
		scopeTree,
	);

	// Freeze Scope drafts into final shape and return.
	const frozenScopes = scopeDrafts.map(draftToScope);
	return Object.freeze({
		filePath,
		moduleScope: moduleScope.id,
		scopes: Object.freeze(frozenScopes),
		parsedImports: Object.freeze(parsedImports.slice()),
		localDefs: Object.freeze(localDefs.slice()),
		referenceSites: Object.freeze(referenceSites.slice()),
	});
}
