import type { SyntaxNode } from "../../../utils/ast-helpers.js";
import { findChildOfType } from "./tree-helpers.js";

export function inferCppCallArgTypes(node: SyntaxNode): string[] | undefined {
	const argList = node.childForFieldName("arguments");
	if (argList === null) return undefined;

	const types: string[] = [];
	for (let i = 0; i < argList.childCount; i++) {
		const child = argList.child(i);
		if (child === null) continue;
		if (child.type === "," || child.type === "(" || child.type === ")") continue;
		const litType = inferCppLiteralType(child);
		if (litType !== "") {
			types.push(litType);
		} else if (child.type === "identifier") {
			// Variable reference — look up declared type in enclosing scope
			types.push(lookupDeclaredTypeForIdentifier(child));
		} else {
			types.push("");
		}
	}
	return types.length > 0 ? types : undefined;
}

/**
 * Infer the canonical type name of a C++ literal AST node.
 * Returns empty string for non-literal / unknown nodes.
 */
export function inferCppLiteralType(node: SyntaxNode): string {
	switch (node.type) {
		case "number_literal": {
			const text = node.text;
			// Floating-point literals contain '.', 'e', 'E', or end with 'f'/'F'
			if (
				text.includes(".") ||
				text.includes("e") ||
				text.includes("E") ||
				text.endsWith("f") ||
				text.endsWith("F")
			) {
				return "double";
			}
			return "int";
		}
		case "string_literal":
		case "raw_string_literal":
		case "concatenated_string":
			return "string";
		case "char_literal":
			return "char";
		case "true":
		case "false":
			return "bool";
		case "null":
		case "nullptr":
			return "null";
		default:
			return "";
	}
}

/**
 * Look up the declared type of a variable by scanning sibling declarations
 * in the enclosing compound_statement (function body). Handles:
 *   - `std::string result = ...` → 'string'
 *   - `int n = ...` → 'int'
 *   - `const int n = ...` → 'int'
 * Returns empty string if no declaration found or type is auto/placeholder.
 */
export function lookupDeclaredTypeForIdentifier(identNode: SyntaxNode): string {
	const varName = identNode.text;
	// Walk up to the enclosing compound_statement (function body)
	let scope: SyntaxNode | null = identNode.parent;
	while (
		scope !== null &&
		scope.type !== "compound_statement" &&
		scope.type !== "translation_unit"
	) {
		scope = scope.parent;
	}
	if (scope === null) return "";

	// Scan declarations in the scope for a matching variable name
	for (let i = 0; i < scope.childCount; i++) {
		const stmt = scope.child(i);
		if (stmt === null || stmt.type !== "declaration") continue;

		const typeNode = stmt.childForFieldName("type");
		if (typeNode === null) continue;
		// Skip auto/placeholder types — those need chain-follow, not literal
		if (typeNode.type === "placeholder_type_specifier") continue;

		// Check init_declarator children for the variable name
		const declarator = stmt.childForFieldName("declarator");
		if (declarator === null) continue;
		if (declarator.type === "init_declarator") {
			const nameChild = declarator.childForFieldName("declarator");
			if (nameChild !== null && nameChild.text === varName) {
				return normalizeCppTypeText(typeNode.text);
			}
		} else if (declarator.text === varName) {
			return normalizeCppTypeText(typeNode.text);
		}
	}
	return "";
}

/** Normalize a type-specifier text for argument type matching.
 *  Strips qualifiers (const, volatile), namespace prefixes (std::),
 *  and pointer/reference markers. */
export function normalizeCppTypeText(text: string): string {
	let t = text.trim();
	t = t.replace(/\b(const|volatile|static|extern|mutable)\b/g, "").trim();
	t = t.replace(/^.*::/, ""); // strip namespace prefix
	t = t.replace(/[*&]/g, "").trim();
	return t;
}

/**
 * Detect whether a `namespace_definition` AST node is inline.
 * Tree-sitter-cpp exposes the `inline` keyword as an anonymous child
 * node — we scan direct children for that keyword.
 */
