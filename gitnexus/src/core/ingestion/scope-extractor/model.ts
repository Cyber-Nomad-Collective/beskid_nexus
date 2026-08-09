import type {
	BindingRef,
	Range,
	Scope,
	ScopeId,
	ScopeKind,
} from "gitnexus-shared";
import { makeScopeId } from "gitnexus-shared";
import type { ScopeDraft } from "./contracts.js";

export function ensureModuleScope(
	scopeDrafts: ScopeDraft[],
	matchCount: number,
	filePath: string,
): ScopeDraft {
	const moduleScope = scopeDrafts.find((s) => s.kind === "Module");
	if (moduleScope !== undefined) return moduleScope;

	if (scopeDrafts.length === 0 && matchCount === 0) {
		const range: Range = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
		const synthetic = makeDraft(
			makeScopeId({ filePath, range, kind: "Module" }),
			null,
			"Module",
			range,
			filePath,
		);
		scopeDrafts.push(synthetic);
		return synthetic;
	}

	throw new Error(
		`ScopeExtractor: no Module scope found for '${filePath}'. ` +
			`Provider must emit at least one @scope.module capture per file.`,
	);
}

export function draftToScope(draft: ScopeDraft): Scope {
	const frozenBindings = new Map<string, readonly BindingRef[]>();
	for (const [name, refs] of draft.bindings) {
		frozenBindings.set(name, Object.freeze(refs.slice()));
	}
	return {
		id: draft.id,
		parent: draft.parent,
		kind: draft.kind,
		range: draft.range,
		filePath: draft.filePath,
		bindings: frozenBindings,
		ownedDefs: Object.freeze(draft.ownedDefs.slice()),
		imports: Object.freeze(draft.imports.slice()),
		typeBindings: new Map(draft.typeBindings),
	};
}

export function makeDraft(
	id: ScopeId,
	parent: ScopeId | null,
	kind: ScopeKind,
	range: Range,
	filePath: string,
): ScopeDraft {
	return {
		id,
		parent,
		kind,
		range,
		filePath,
		bindings: new Map(),
		ownedDefs: [],
		imports: [],
		typeBindings: new Map(),
	};
}
