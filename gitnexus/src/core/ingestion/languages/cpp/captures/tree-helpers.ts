import type { SyntaxNode } from "../../../utils/ast-helpers.js";

export function findChildOfType(
	node: SyntaxNode,
	types: readonly string[],
): SyntaxNode | null {
	for (let i = 0; i < node.childCount; i++) {
		const c = node.child(i);
		if (c !== null && types.includes(c.type)) return c;
	}
	return null;
}

/** Recursive search for the first descendant of a given type. */
export function findFirstDescendantOfType(
	node: SyntaxNode,
	type: string,
): SyntaxNode | null {
	if (node.type === type) return node;
	for (let i = 0; i < node.childCount; i++) {
		const c = node.child(i);
		if (c === null) continue;
		const hit = findFirstDescendantOfType(c, type);
		if (hit !== null) return hit;
	}
	return null;
}

/** Get the name of a class/struct/template_type node via its `name` field. */
export function getTypeIdentifierName(node: SyntaxNode): string {
	const nameNode = node.childForFieldName("name");
	if (nameNode !== null) return nameNode.text;
	const id = findFirstDescendantOfType(node, "type_identifier");
	return id !== null ? id.text : "";
}

/**
 * Infer argument types from a call_expression or new_expression node.
 * Used for overload disambiguation by parameter types.
 *
 * Only literal types are inferred — identifiers and complex expressions
 * return empty string (unknown) so narrowOverloadCandidates treats them
 * as any-match.
 */
