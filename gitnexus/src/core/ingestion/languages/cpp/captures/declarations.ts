import type { SyntaxNode } from "../../../utils/ast-helpers.js";

/**
 * Walk a declarator node chain, unwrapping pointer/reference/function/
 * parenthesized wrappers, and return the text of the innermost identifier.
 * Returns `null` when no identifier is found within `safety` steps.
 * Used by `lookupAdlIdentifierType` to extract the variable name from
 * function-pointer declarator trees such as `(*g)()` in `void (*g)()`.
 */
export function extractDeclaratorLeafName(node: SyntaxNode): string | null {
	let cur: SyntaxNode = node;
	let safety = 16;
	while (safety-- > 0) {
		if (cur.type === "identifier" || cur.type === "type_identifier")
			return cur.text;
		// Common wrapper nodes — follow the 'declarator' field when present.
		const next =
			cur.childForFieldName("declarator") ??
			// parenthesized_declarator: single named child
			(cur.type === "parenthesized_declarator" ? cur.namedChild(0) : null);
		if (next === null) return null;
		cur = next;
	}
	return null;
}

/**
 * Check if a C++ function_definition or declaration has `static` storage class.
 */
export function hasStaticStorageClass(node: SyntaxNode): boolean {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (
			child !== null &&
			child.type === "storage_class_specifier" &&
			child.text === "static"
		) {
			return true;
		}
	}
	return false;
}

/**
 * Check if a node is inside an anonymous namespace (file-local linkage in C++).
 * Anonymous namespaces have no `name` field in tree-sitter-cpp.
 */
export function isInsideAnonymousNamespace(node: SyntaxNode): boolean {
	let ancestor: SyntaxNode | null = node.parent ?? null;
	while (ancestor !== null) {
		if (ancestor.type === "namespace_definition") {
			// Anonymous namespace: has declaration_list but no name child
			const nameChild = ancestor.childForFieldName?.("name") ?? null;
			if (nameChild === null) return true;
		}
		ancestor = ancestor.parent;
	}
	return false;
}
