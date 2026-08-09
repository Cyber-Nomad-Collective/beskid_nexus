import type {
	CaptureMatch,
	Range,
	ScopeId,
	SymbolDefinition,
	buildPositionIndex,
	buildScopeTree,
} from "gitnexus-shared";
import { extractTemplateArguments } from "../utils/template-arguments.js";
import type { ScopeDraft, ScopeExtractorHooks } from "./contracts.js";
import { draftToScope } from "./model.js";
import { anchorCaptureFor, rangesEqual } from "./references.js";

// ─── Pass 2: attach declarations + local bindings ──────────────────────────

export function pass2AttachDeclarations(
	matches: readonly CaptureMatch[],
	drafts: readonly ScopeDraft[],
	positionIndex: ReturnType<typeof buildPositionIndex>,
	localDefs: SymbolDefinition[],
	filePath: string,
	provider: ScopeExtractorHooks,
	scopeTree: ReturnType<typeof buildScopeTree>,
): void {
	const draftById = new Map<ScopeId, ScopeDraft>();
	for (const d of drafts) draftById.set(d.id, d);

	for (const match of matches) {
		const anchor = anchorCaptureFor(match, "@declaration.");
		if (anchor === undefined) continue;

		const def = buildDefFromDeclarationMatch(match, anchor, filePath);
		if (def === undefined) continue;

		// Find the innermost scope that contains the declaration's anchor range.
		const innermostId = positionIndex.atPosition(
			filePath,
			anchor.range.startLine,
			anchor.range.startCol,
		);
		if (innermostId === undefined) continue;
		const innermost = draftById.get(innermostId);
		if (innermost === undefined) continue;

		// Ownership: attach the def to the innermost scope's `ownedDefs` — that
		// is the structural owner. `def.ownerId` is NOT populated here — the
		// extractor has no clean path to the parent's own DefId mid-extraction
		// (the parent declaration may not yet have been processed, or may live
		// in a different scope entirely). Providers that need `ownerId` should
		// set it directly from the declaration hook (e.g., derive from the
		// `@declaration.owner` capture or the parent scope id); otherwise
		// `finalize` populates method/field `ownerId` via `MethodDispatchIndex`
		// (#914) in a follow-up pass that sees every def already in place.
		innermost.ownedDefs.push(def);
		localDefs.push(def);

		// Binding visibility: default to innermost; allow hoisting via
		// `provider.bindingScopeFor`. `draftToScope(innermost)` here is a
		// **structural** snapshot — parent/range/kind only. Hooks MUST NOT
		// rely on `scope.bindings`, `ownedDefs`, or `typeBindings` being
		// populated during Pass 2: those fields are written across passes,
		// so reading them mid-extraction yields a partial view. The
		// `scopeTree` argument is similarly snapshot-before-mutation.
		//
		// Auto-hoist for scope-creating declarations: when the declaration's
		// anchor range is the same node that produced `innermost` (e.g. a
		// `function_definition` is both `@scope.function` and the
		// `@declaration.function` anchor), the name is visible OUTSIDE the
		// body, not inside. Hoisting to the parent scope is what every
		// mainstream language wants for function/class declarations. Hooks
		// can override by returning a non-null scope id.
		const autoHostedId =
			innermost.parent !== null && rangesEqual(anchor.range, innermost.range)
				? innermost.parent
				: innermost.id;
		const bindingScopeId =
			provider.bindingScopeFor?.(match, draftToScope(innermost), scopeTree) ??
			autoHostedId;
		const bindingHost = draftById.get(bindingScopeId) ?? innermost;

		const nameKey = deriveDeclarationName(match, def);
		if (nameKey === undefined) continue;

		const existing = bindingHost.bindings.get(nameKey) ?? [];
		existing.push({ def, origin: "local" });
		bindingHost.bindings.set(nameKey, existing);
	}
}

export function buildDefFromDeclarationMatch(
	match: CaptureMatch,
	anchor: {
		readonly name: string;
		readonly range: Range;
		readonly text: string;
	},
	filePath: string,
): SymbolDefinition | undefined {
	// Anchor name pattern: `@declaration.<kind>` where <kind> maps to NodeLabel.
	const kindStr = anchor.name.slice("@declaration.".length);
	const type = normalizeNodeLabel(kindStr);
	if (type === undefined) return undefined;

	const nameCap =
		match["@declaration.name"] ??
		match[`@declaration.${kindStr}.name`] ??
		match[anchor.name];
	if (nameCap === undefined) return undefined;

	const qualifiedCap = match["@declaration.qualified_name"];
	const qualifiedName = qualifiedCap?.text;
	const templateArguments =
		extractTemplateArguments(
			match["@declaration.template-arguments"]?.text ?? "",
		) ?? extractTemplateArguments(qualifiedName ?? nameCap.text);

	// Optional arity metadata — producers (e.g. Python emit-captures)
	// synthesize these on function/method declarations. Their absence is
	// the normal case for other producers; readers treat undefined as
	// "unknown" per `SymbolDefinition` contract.
	const parameterCount = parseIntCapture(match["@declaration.parameter-count"]);
	const requiredParameterCount = parseIntCapture(
		match["@declaration.required-parameter-count"],
	);
	const parameterTypes = parseJsonStringArrayCapture(
		match["@declaration.parameter-types"],
	);
	const declaredType = match["@declaration.field-type"]?.text;
	const returnType = match["@declaration.return-type"]?.text;

	return {
		nodeId: makeDefId(filePath, anchor.range, type, nameCap.text),
		filePath,
		type,
		...(qualifiedName !== undefined
			? { qualifiedName }
			: { qualifiedName: nameCap.text }),
		...(parameterCount !== undefined ? { parameterCount } : {}),
		...(requiredParameterCount !== undefined ? { requiredParameterCount } : {}),
		...(parameterTypes !== undefined ? { parameterTypes } : {}),
		...(declaredType !== undefined ? { declaredType } : {}),
		...(returnType !== undefined ? { returnType } : {}),
		...(templateArguments !== undefined ? { templateArguments } : {}),
	};
}

export function parseIntCapture(
	cap: { readonly text: string } | undefined,
): number | undefined {
	if (cap === undefined) return undefined;
	const n = Number.parseInt(cap.text, 10);
	return Number.isFinite(n) ? n : undefined;
}

export function parseJsonStringArrayCapture(
	cap: { readonly text: string } | undefined,
): string[] | undefined {
	if (cap === undefined) return undefined;
	try {
		const parsed = JSON.parse(cap.text) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		return parsed.every((x): x is string => typeof x === "string")
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

export function deriveDeclarationName(
	match: CaptureMatch,
	def: SymbolDefinition,
): string | undefined {
	const nameCap =
		match["@declaration.name"] ??
		match[
			Object.keys(match).find(
				(k) => k.startsWith("@declaration.") && k.endsWith(".name"),
			) ?? ""
		];
	if (nameCap !== undefined) return nameCap.text;
	// Fall back to qualifiedName tail.
	const q = def.qualifiedName;
	if (q !== undefined && q.length > 0) {
		const dot = q.lastIndexOf(".");
		return dot === -1 ? q : q.slice(dot + 1);
	}
	return undefined;
}

/**
 * Map a lower-case declaration kind (from `@declaration.<kind>`) to a
 * graph `NodeLabel`. Silently returns `undefined` for kinds we don't
 * recognize — providers can emit richer captures without breaking the
 * driver.
 */
export function normalizeNodeLabel(
	kindStr: string,
): SymbolDefinition["type"] | undefined {
	switch (kindStr.toLowerCase()) {
		case "class":
			return "Class";
		case "interface":
			return "Interface";
		case "enum":
			return "Enum";
		case "struct":
			return "Struct";
		case "union":
			return "Union";
		case "trait":
			return "Trait";
		case "method":
			return "Method";
		case "function":
			return "Function";
		case "constructor":
			return "Constructor";
		case "field":
		case "property":
			return "Property";
		case "variable":
		case "const":
			return "Variable";
		case "typealias":
		case "type_alias":
			return "TypeAlias";
		case "typedef":
			return "Typedef";
		case "record":
			return "Record";
		case "delegate":
			return "Delegate";
		case "annotation":
			return "Annotation";
		case "namespace":
			return "Namespace";
		default:
			return undefined;
	}
}

export function makeDefId(
	filePath: string,
	range: Range,
	type: SymbolDefinition["type"],
	name: string,
): string {
	return `def:${filePath}#${range.startLine}:${range.startCol}:${type}:${name}`;
}
