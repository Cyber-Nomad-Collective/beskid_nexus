import type { SyntaxNode } from "../../utils/ast-helpers.js";
import { extractSimpleTypeName } from "./normalization.js";

/**
 * Extract variable name from a declarator or pattern node.
 * Returns the simple identifier text, or undefined for destructuring/complex patterns.
 */
export const extractVarName = (node: SyntaxNode): string | undefined => {
	if (
		node.type === "identifier" ||
		node.type === "simple_identifier" ||
		node.type === "variable_name" ||
		node.type === "name" ||
		node.type === "constant" ||
		node.type === "property_identifier"
	) {
		return node.text;
	}
	// variable_declarator (Java/C#): has a 'name' field
	if (node.type === "variable_declarator") {
		const nameChild = node.childForFieldName("name");
		if (nameChild) return extractVarName(nameChild);
	}
	// Rust: let mut x = ... — mut_pattern wraps an identifier
	if (node.type === "mut_pattern") {
		const inner = node.firstNamedChild;
		if (inner) return extractVarName(inner);
	}
	// Swift: pattern node wraps a simple_identifier
	if (node.type === "pattern") {
		const inner = node.firstNamedChild;
		if (inner) return extractVarName(inner);
	}
	return undefined;
};

/** Node types for function/method parameters with type annotations */
export const TYPED_PARAMETER_TYPES = new Set([
	"required_parameter", // TS: (x: Foo)
	"optional_parameter", // TS: (x?: Foo)
	"formal_parameter", // Java/Kotlin
	"parameter", // C#/Rust/Go/Python/Swift
	"typed_parameter", // Python: def f(x: Foo) — distinct from 'parameter' in tree-sitter-python
	"parameter_declaration", // C/C++ void f(Type name)
	"simple_parameter", // PHP function(Foo $x)
	"property_promotion_parameter", // PHP 8.0+ constructor promotion: __construct(private Foo $x)
	"closure_parameter", // Rust: |user: User| — typed closure parameters
]);

/**
 * Match Ruby constructor assignment: `user = User.new` or `service = Models::User.new`.
 * Returns { varName, calleeName } or undefined if the node is not a Ruby constructor assignment.
 * Handles both simple constants and scope_resolution (namespaced) receivers.
 */
export const extractRubyConstructorAssignment = (
	node: SyntaxNode,
): { varName: string; calleeName: string } | undefined => {
	if (node.type !== "assignment") return undefined;
	const left = node.childForFieldName("left");
	const right = node.childForFieldName("right");
	if (!left || !right) return undefined;
	if (left.type !== "identifier" && left.type !== "constant") return undefined;
	if (right.type !== "call") return undefined;
	const method = right.childForFieldName("method");
	if (method?.text !== "new") return undefined;
	const receiver = right.childForFieldName("receiver");
	if (!receiver) return undefined;
	let calleeName: string;
	if (receiver.type === "constant") {
		calleeName = receiver.text;
	} else if (receiver.type === "scope_resolution") {
		// Models::User → extract last segment "User"
		const last = receiver.lastNamedChild;
		if (last?.type !== "constant") return undefined;
		calleeName = last.text;
	} else {
		return undefined;
	}
	return { varName: left.text, calleeName };
};

/**
 * Check if an AST node has an explicit type annotation.
 * Checks both named fields ('type') and child nodes ('type_annotation').
 * Used by constructor binding scanners to skip annotated declarations.
 */
export const hasTypeAnnotation = (node: SyntaxNode): boolean => {
	if (node.childForFieldName("type")) return true;
	for (let i = 0; i < node.childCount; i++) {
		if (node.child(i)?.type === "type_annotation") return true;
	}
	return false;
};

/** Bare nullable keywords that should not produce a receiver binding. */
const NULLABLE_KEYWORDS = new Set(["null", "undefined", "void", "None", "nil"]);

/**
 * Strip nullable wrappers from a type name string.
 * Used by both lookupInEnv (TypeEnv annotations) and extractReturnTypeName
 * (return-type text) to normalize types before receiver lookup.
 *
 *   "User | null"           → "User"
 *   "User | undefined"      → "User"
 *   "User | null | undefined" → "User"
 *   "User?"                 → "User"
 *   "User | Repo"           → undefined  (genuine union — refuse)
 *   "null"                  → undefined
 */
export const stripNullable = (typeName: string): string | undefined => {
	let text = typeName.trim();
	if (!text) return undefined;

	if (NULLABLE_KEYWORDS.has(text)) return undefined;

	// Strip nullable suffix: User? → User
	if (text.endsWith("?")) text = text.slice(0, -1).trim();

	// Strip union with null/undefined/None/nil/void
	if (text.includes("|")) {
		const parts = text
			.split("|")
			.map((p) => p.trim())
			.filter((p) => p !== "" && !NULLABLE_KEYWORDS.has(p));
		if (parts.length === 1) return parts[0];
		return undefined; // genuine union or all-nullable — refuse
	}

	return text || undefined;
};

/**
 * Unwrap an await_expression to get the inner value.
 * Returns the node itself if not an await_expression, or null if input is null.
 */
export const unwrapAwait = (node: SyntaxNode | null): SyntaxNode | null => {
	if (!node) return null;
	return node.type === "await_expression" ? node.firstNamedChild : node;
};

/**
 * Extract the callee name from a call_expression node.
 * Navigates to the 'function' field (or first named child) and extracts a simple type name.
 */
export const extractCalleeName = (callNode: SyntaxNode): string | undefined => {
	const func =
		callNode.childForFieldName("function") ?? callNode.firstNamedChild;
	if (!func) return undefined;
	return extractSimpleTypeName(func);
};
