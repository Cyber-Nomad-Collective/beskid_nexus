import {
	extractSimpleTypeName,
	stripNullable,
} from "../type-extractors/shared.js";
import {
	FUNCTION_NODE_TYPES,
	type SyntaxNode,
} from "../utils/ast-helpers.js";

/** Fallback for languages where class names aren't in a 'name' field (e.g. Kotlin uses type_identifier). */
export const findTypeIdentifierChild = (node: SyntaxNode): SyntaxNode | null => {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child && child.type === "type_identifier") return child;
	}
	return null;
};
/** AST node types that represent mutually exclusive branch containers for pattern bindings.
 *  Includes both multi-arm pattern-match branches AND if-statement bodies for null-check narrowing. */
const NARROWING_BRANCH_TYPES = new Set([
	"when_entry", // Kotlin when
	"switch_block_label", // Java switch (enhanced)
	"if_statement", // TS/JS, Java, C/C++
	"if_expression", // Kotlin (if is an expression)
	"statement_block", // TS/JS: { ... } body of if
	"control_structure_body", // Kotlin: body of if
]);

/** Walk up the AST from a pattern node to find the enclosing branch container. */
export const findNarrowingBranchScope = (node: SyntaxNode): SyntaxNode | undefined => {
	let current = node.parent;
	while (current) {
		if (NARROWING_BRANCH_TYPES.has(current.type)) return current;
		if (FUNCTION_NODE_TYPES.has(current.type)) return undefined;
		current = current.parent;
	}
	return undefined;
};

/** Bare nullable keywords that fastStripNullable must reject. */
const FAST_NULLABLE_KEYWORDS = new Set([
	"null",
	"undefined",
	"void",
	"None",
	"nil",
]);

/**
 * Fast-path nullable check: 90%+ of type names are simple identifiers (e.g. "User")
 * that don't need the full stripNullable parse. Only call stripNullable when the
 * string contains nullable markers ('|' for union types, '?' for nullable suffix).
 */
export const fastStripNullable = (typeName: string): string | undefined => {
	if (FAST_NULLABLE_KEYWORDS.has(typeName)) return undefined;
	return typeName.indexOf("|") === -1 && typeName.indexOf("?") === -1
		? typeName
		: stripNullable(typeName);
};

/** Extract the parent/superclass name from a class declaration AST node. */
export const extractParentClassFromNode = (
	classNode: SyntaxNode,
): string | undefined => {
	// 1. Named fields: Java (superclass), Ruby (superclass), Python (superclasses)
	const superclassNode = classNode.childForFieldName("superclass");
	if (superclassNode) {
		// Java: superclass > type_identifier or generic_type, Ruby: superclass > constant
		const inner =
			superclassNode.childForFieldName("type") ??
			superclassNode.firstNamedChild ??
			superclassNode;
		return extractSimpleTypeName(inner) ?? inner.text;
	}

	const superclassesNode = classNode.childForFieldName("superclasses");
	if (superclassesNode) {
		// Python: argument_list with identifiers or attribute nodes (e.g. models.Model)
		const first = superclassesNode.firstNamedChild;
		if (first) return extractSimpleTypeName(first) ?? first.text;
	}

	// 2. Unnamed children: walk class node's children looking for heritage nodes
	for (let i = 0; i < classNode.childCount; i++) {
		const child = classNode.child(i);
		if (!child) continue;

		switch (child.type) {
			// TypeScript: class_heritage > extends_clause > type_identifier
			// JavaScript: class_heritage > identifier (no extends_clause wrapper)
			case "class_heritage": {
				for (let j = 0; j < child.childCount; j++) {
					const clause = child.child(j);
					if (clause?.type === "extends_clause") {
						const typeNode = clause.firstNamedChild;
						if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text;
					}
					// JS: direct identifier child (no extends_clause wrapper)
					if (clause?.type === "identifier" || clause?.type === "type_identifier") {
						return clause.text;
					}
				}
				break;
			}

			// C#: base_list > identifier or generic_name > identifier
			case "base_list": {
				const first = child.firstNamedChild;
				if (first) {
					// generic_name wraps the identifier: BaseClass<T>
					if (first.type === "generic_name") {
						const inner = first.childForFieldName("name") ?? first.firstNamedChild;
						if (inner) return inner.text;
					}
					return first.text;
				}
				break;
			}

			// PHP: base_clause > name
			case "base_clause": {
				const name = child.firstNamedChild;
				if (name) return name.text;
				break;
			}

			// C++: base_class_clause > type_identifier (with optional access_specifier before it)
			case "base_class_clause": {
				for (let j = 0; j < child.childCount; j++) {
					const inner = child.child(j);
					if (inner?.type === "type_identifier") return inner.text;
				}
				break;
			}

			// Kotlin: delegation_specifier > constructor_invocation > user_type > type_identifier
			case "delegation_specifier": {
				const delegate = child.firstNamedChild;
				if (delegate?.type === "constructor_invocation") {
					const userType = delegate.firstNamedChild;
					if (userType?.type === "user_type") {
						const typeId = userType.firstNamedChild;
						if (typeId) return typeId.text;
					}
				}
				// Also handle plain user_type (interface conformance without parentheses)
				if (delegate?.type === "user_type") {
					const typeId = delegate.firstNamedChild;
					if (typeId) return typeId.text;
				}
				break;
			}

			// Swift: inheritance_specifier > user_type > type_identifier
			case "inheritance_specifier": {
				const userType =
					child.childForFieldName("inherits_from") ?? child.firstNamedChild;
				if (userType?.type === "user_type") {
					const typeId = userType.firstNamedChild;
					if (typeId) return typeId.text;
				}
				break;
			}
		}
	}

	return undefined;
};

