import type {
	CaptureMatch,
	Range,
	ReferenceKind,
	ReferenceSite,
	ScopeId,
	buildPositionIndex,
	buildScopeTree,
} from "gitnexus-shared";
import type { ScopeExtractorHooks } from "./contracts.js";

// ─── Pass 5: collect reference sites ───────────────────────────────────────

export function pass5CollectReferences(
	matches: readonly CaptureMatch[],
	positionIndex: ReturnType<typeof buildPositionIndex>,
	filePath: string,
	referenceSites: ReferenceSite[],
	provider: ScopeExtractorHooks,
	scopeTree: ReturnType<typeof buildScopeTree>,
): void {
	for (const match of matches) {
		const anchor = anchorCaptureFor(match, "@reference.");
		if (anchor === undefined) continue;

		const kind = referenceKindFromAnchor(anchor.name);
		if (kind === undefined) continue;

		const nameCap = match["@reference.name"] ?? anchor;
		const inScopeId = positionIndex.atPosition(
			filePath,
			anchor.range.startLine,
			anchor.range.startCol,
		);
		if (inScopeId === undefined) continue;

		const callForm =
			kind === "call"
				? classifyCallFormForMatch(
						match,
						anchor.name,
						provider,
						scopeTree,
						inScopeId,
					)
				: undefined;
		const explicitReceiver = extractExplicitReceiver(match);
		const arity = extractArity(match);
		const argumentTypes = extractArgumentTypes(match);

		const site: ReferenceSite = {
			name: nameCap.text,
			atRange: anchor.range,
			inScope: inScopeId,
			kind,
			...(callForm !== undefined ? { callForm } : {}),
			...(explicitReceiver !== undefined ? { explicitReceiver } : {}),
			...(arity !== undefined ? { arity } : {}),
			...(argumentTypes !== undefined ? { argumentTypes } : {}),
		};
		referenceSites.push(site);
	}
}

export function referenceKindFromAnchor(
	name: string,
): ReferenceKind | undefined {
	const suffix = name.slice("@reference.".length);
	// Strip sub-tag after the kind (`@reference.call.member` → `call`).
	const firstDot = suffix.indexOf(".");
	const head = firstDot === -1 ? suffix : suffix.slice(0, firstDot);
	switch (head.toLowerCase()) {
		case "call":
			return "call";
		case "read":
			return "read";
		case "write":
			return "write";
		case "type":
		case "type_reference":
			return "type-reference";
		case "inherits":
			return "inherits";
		case "import_use":
		case "import-use":
			return "import-use";
		default:
			return undefined;
	}
}

export function classifyCallFormForMatch(
	match: CaptureMatch,
	anchorName: string,
	provider: ScopeExtractorHooks,
	scopeTree: ReturnType<typeof buildScopeTree>,
	inScopeId: ScopeId,
): "free" | "member" | "constructor" | "index" {
	// Declarative sub-tag path first: `@reference.call.member` → 'member'.
	const suffix = anchorName.slice("@reference.call.".length);
	switch (suffix.toLowerCase()) {
		case "free":
			return "free";
		case "member":
			return "member";
		case "constructor":
			return "constructor";
		case "index":
			return "index";
	}

	// Hook-based path: provider knows.
	const hook = provider.classifyCallForm;
	if (hook !== undefined) {
		const scope = scopeTree.getScope(inScopeId);
		if (scope !== undefined) return hook(match, scope);
	}

	return "free";
}

export function extractExplicitReceiver(
	match: CaptureMatch,
): { readonly name: string } | undefined {
	const cap = match["@reference.receiver"];
	if (cap === undefined) return undefined;
	return { name: cap.text };
}

export function extractArity(match: CaptureMatch): number | undefined {
	const cap = match["@reference.arity"];
	if (cap === undefined) return undefined;
	const n = Number.parseInt(cap.text, 10);
	return Number.isFinite(n) ? n : undefined;
}

export function extractArgumentTypes(
	match: CaptureMatch,
): readonly string[] | undefined {
	const cap = match["@reference.parameter-types"];
	if (cap === undefined) return undefined;
	try {
		const parsed = JSON.parse(cap.text);
		if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string"))
			return parsed;
	} catch {
		/* malformed — fall through */
	}
	return undefined;
}

// ─── Internal: range + capture utilities ───────────────────────────────────

export function rangesEqual(a: Range, b: Range): boolean {
	return (
		a.startLine === b.startLine &&
		a.startCol === b.startCol &&
		a.endLine === b.endLine &&
		a.endCol === b.endCol
	);
}

/**
 * Capture names that are never anchors — they are sub-tags nested inside a
 * larger anchor (e.g., the receiver expression inside a `@reference.call`
 * may span more source than the called name, but is not the call itself).
 *
 * The list is maintained here centrally rather than per-pass because the
 * set is small and stable; adding a new sub-tag convention is a one-line
 * change.
 */
export const KNOWN_SUB_TAGS: ReadonlySet<string> = new Set<string>([
	"@declaration.name",
	"@declaration.qualified_name",
	"@import.name",
	"@import.source",
	"@import.alias",
	"@type-binding.name",
	"@type-binding.type",
	"@reference.name",
	"@reference.receiver",
	"@reference.arity",
	"@reference.parameter-types",
	"@declaration.parameter-count",
	"@declaration.required-parameter-count",
	"@declaration.parameter-types",
]);

/**
 * Return the anchor capture for a match — the one whose name begins with
 * `prefix` AND is not in the known-sub-tag set. When multiple candidates
 * remain, the broadest-ranged one wins: tree-sitter queries often tag
 * both a whole statement and a sub-token under the same topic
 * (`@scope.function` + `@scope.function.name`); the anchor is the
 * statement-level one.
 */
export function anchorCaptureFor(
	match: CaptureMatch,
	prefix: string,
):
	| { readonly name: string; readonly range: Range; readonly text: string }
	| undefined {
	let best:
		| { readonly name: string; readonly range: Range; readonly text: string }
		| undefined;
	let bestSpan = -1;
	for (const name of Object.keys(match)) {
		if (!name.startsWith(prefix)) continue;
		if (KNOWN_SUB_TAGS.has(name)) continue;
		const cap = match[name]!;
		const span =
			(cap.range.endLine - cap.range.startLine) * 1_000_000 +
			(cap.range.endCol - cap.range.startCol);
		if (span > bestSpan) {
			bestSpan = span;
			best = cap;
		}
	}
	return best;
}
