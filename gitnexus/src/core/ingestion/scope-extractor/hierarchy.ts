import type { CaptureMatch, Range, ScopeId, ScopeKind } from "gitnexus-shared";
import { canParentScope, makeScopeId } from "gitnexus-shared";
import type { ScopeDraft, ScopeExtractorHooks } from "./contracts.js";
import { makeDraft } from "./model.js";
import { anchorCaptureFor } from "./references.js";

// ─── Pass 1: build scope tree ──────────────────────────────────────────────

/**
 * Convert `@scope.*` matches into `ScopeDraft[]`. Parent relationships
 * are derived from range containment (outermost scope containing `range`
 * becomes the parent).
 */
export function pass1BuildScopes(
	matches: readonly CaptureMatch[],
	filePath: string,
	provider: ScopeExtractorHooks,
): ScopeDraft[] {
	interface Candidate {
		readonly match: CaptureMatch;
		readonly range: Range;
		readonly kind: ScopeKind;
		readonly id: ScopeId;
	}

	const candidates: Candidate[] = [];
	for (const match of matches) {
		const anchor = anchorCaptureFor(match, "@scope.");
		if (anchor === undefined) continue;
		const kind = resolveKindForScopeMatch(match, anchor, provider);
		if (kind === null) continue;
		const id = makeScopeId({ filePath, range: anchor.range, kind });
		candidates.push({ match, range: anchor.range, kind, id });
	}

	// Sort by (startLine, startCol) ASC, (endLine, endCol) DESC so outer
	// scopes appear before their children for parent-resolution. When two
	// candidates have exactly equal ranges (e.g. a `compilation_unit` and
	// the only top-level scope in the file — see `canParentScope`), Module
	// sorts first so it lands on the stack ahead of the candidate that will
	// claim it as parent.
	candidates.sort((a, b) => {
		if (a.range.startLine !== b.range.startLine)
			return a.range.startLine - b.range.startLine;
		if (a.range.startCol !== b.range.startCol)
			return a.range.startCol - b.range.startCol;
		if (a.range.endLine !== b.range.endLine)
			return b.range.endLine - a.range.endLine;
		if (a.range.endCol !== b.range.endCol) return b.range.endCol - a.range.endCol;
		if (a.kind === b.kind) return 0;
		if (a.kind === "Module") return -1;
		if (b.kind === "Module") return 1;
		return 0;
	});

	const drafts: ScopeDraft[] = [];
	const stack: Candidate[] = []; // enclosing real scopes, outermost at [0]

	for (const cand of candidates) {
		// Pop the stack until the top can parent this candidate (strict
		// containment, plus the equal-range Module carve-out).
		while (
			stack.length > 0 &&
			!canParentScope(
				stack[stack.length - 1]?.range,
				cand.range,
				stack[stack.length - 1]?.kind,
				cand.kind,
			)
		) {
			stack.pop();
		}

		const parent = stack.length > 0 ? stack[stack.length - 1]?.id : null;
		drafts.push(makeDraft(cand.id, parent, cand.kind, cand.range, filePath));
		stack.push(cand);
	}

	return drafts;
}

export function resolveKindForScopeMatch(
	match: CaptureMatch,
	anchor: { readonly name: string },
	provider: ScopeExtractorHooks,
): ScopeKind | null {
	// Provider override takes precedence.
	const override = provider.resolveScopeKind?.(match);
	if (override !== undefined && override !== null) return override;

	// Default: derive from capture name suffix (`@scope.function` → 'Function').
	const suffix = anchor.name.slice("@scope.".length);
	switch (suffix.toLowerCase()) {
		case "module":
			return "Module";
		case "namespace":
			return "Namespace";
		case "class":
			return "Class";
		case "function":
			return "Function";
		case "block":
			return "Block";
		case "expression":
			return "Expression";
		default:
			return null;
	}
}
