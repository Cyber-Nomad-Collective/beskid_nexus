import type { SyntaxNode } from "../../utils/ast-helpers.js";

/** Known single-arg nullable wrapper types that unwrap to their inner type
 *  for receiver resolution. Optional<User> → "User", Option<User> → "User".
 *  Only nullable wrappers — NOT containers (List, Vec) or async wrappers (Promise, Future).
 *  See WRAPPER_GENERICS below for the full set used in return-type inference. */
const NULLABLE_WRAPPER_TYPES = new Set([
	"Optional", // Java
	"Option", // Rust, Scala
	"Maybe", // Haskell-style, Kotlin Arrow
]);

/**
 * Extract the simple type name from a type AST node.
 * Handles generic types (e.g., List<User> → List), qualified names
 * (e.g., models.User → User), and nullable types (e.g., User? → User).
 * Returns undefined for complex types (unions, intersections, function types).
 */
export const extractSimpleTypeName = (
	typeNode: SyntaxNode,
	depth = 0,
): string | undefined => {
	if (depth > 50 || typeNode.text.length > 2048) return undefined;
	// Direct type identifier (includes Ruby 'constant' for class names)
	if (
		typeNode.type === "type_identifier" ||
		typeNode.type === "identifier" ||
		typeNode.type === "simple_identifier" ||
		typeNode.type === "constant"
	) {
		return typeNode.text;
	}

	// Qualified/scoped names: take the last segment (e.g., models.User → User, Models::User → User)
	if (
		typeNode.type === "scoped_identifier" ||
		typeNode.type === "qualified_identifier" ||
		typeNode.type === "scoped_type_identifier" ||
		typeNode.type === "qualified_name" ||
		typeNode.type === "qualified_type" ||
		typeNode.type === "member_expression" ||
		typeNode.type === "member_access_expression" ||
		typeNode.type === "attribute" ||
		typeNode.type === "scope_resolution" ||
		typeNode.type === "selector_expression"
	) {
		const last = typeNode.lastNamedChild;
		if (
			last &&
			(last.type === "type_identifier" ||
				last.type === "identifier" ||
				last.type === "simple_identifier" ||
				last.type === "name" ||
				last.type === "constant" ||
				last.type === "property_identifier" ||
				last.type === "field_identifier")
		) {
			return last.text;
		}
	}

	// C++ template_type (e.g., vector<User>, map<string, User>): extract base name
	if (typeNode.type === "template_type") {
		const base = typeNode.childForFieldName("name") ?? typeNode.firstNamedChild;
		if (base) return extractSimpleTypeName(base, depth + 1);
	}

	// Generic types: extract the base type (e.g., List<User> → List)
	// For nullable wrappers (Optional<User>, Option<User>), unwrap to inner type.
	if (
		typeNode.type === "generic_type" ||
		typeNode.type === "parameterized_type" ||
		typeNode.type === "generic_name"
	) {
		const base =
			typeNode.childForFieldName("name") ??
			typeNode.childForFieldName("type") ??
			typeNode.firstNamedChild;
		if (!base) return undefined;
		const baseName = extractSimpleTypeName(base, depth + 1);
		// Unwrap known nullable wrappers: Optional<User> → User, Option<User> → User
		if (baseName && NULLABLE_WRAPPER_TYPES.has(baseName)) {
			const args = extractGenericTypeArgs(typeNode);
			if (args.length >= 1) return args[0];
		}
		return baseName;
	}

	// Nullable types (Kotlin User?, C# User?)
	if (typeNode.type === "nullable_type") {
		const inner = typeNode.firstNamedChild;
		if (inner) return extractSimpleTypeName(inner, depth + 1);
	}

	// Nullable union types (TS/JS: User | null, User | undefined, User | null | undefined)
	// Extract the single non-null/undefined type from the union.
	if (typeNode.type === "union_type") {
		const nonNullTypes: SyntaxNode[] = [];
		for (let i = 0; i < typeNode.namedChildCount; i++) {
			const child = typeNode.namedChild(i);
			if (!child) continue;
			// Skip null/undefined/void literal types
			const text = child.text;
			if (text === "null" || text === "undefined" || text === "void") continue;
			nonNullTypes.push(child);
		}
		// Only unwrap if exactly one meaningful type remains
		if (nonNullTypes.length === 1) {
			return extractSimpleTypeName(nonNullTypes[0], depth + 1);
		}
	}

	// Type annotations that wrap the actual type (TS/Python: `: Foo`, Kotlin: user_type)
	if (
		typeNode.type === "type_annotation" ||
		typeNode.type === "type" ||
		typeNode.type === "user_type"
	) {
		const inner = typeNode.firstNamedChild;
		if (inner) return extractSimpleTypeName(inner, depth + 1);
	}

	// Pointer/reference types (C++, Rust): User*, &User, &mut User
	if (typeNode.type === "pointer_type" || typeNode.type === "reference_type") {
		// Skip mutable_specifier for Rust &mut references — firstNamedChild would be
		// `mutable_specifier` not the actual type. Walk named children to find the type.
		for (let i = 0; i < typeNode.namedChildCount; i++) {
			const child = typeNode.namedChild(i);
			if (child && child.type !== "mutable_specifier") {
				return extractSimpleTypeName(child, depth + 1);
			}
		}
	}

	// Primitive/predefined types: string, int, float, bool, number, unknown, any
	// PHP: primitive_type; TS/JS: predefined_type
	// Java: integral_type (int/long/short/byte), floating_point_type (float/double),
	//       boolean_type (boolean), void_type (void)
	if (
		typeNode.type === "primitive_type" ||
		typeNode.type === "predefined_type" ||
		typeNode.type === "integral_type" ||
		typeNode.type === "floating_point_type" ||
		typeNode.type === "boolean_type" ||
		typeNode.type === "void_type"
	) {
		return typeNode.text;
	}

	// PHP named_type / optional_type
	if (typeNode.type === "named_type" || typeNode.type === "optional_type") {
		const inner = typeNode.childForFieldName("name") ?? typeNode.firstNamedChild;
		if (inner) return extractSimpleTypeName(inner, depth + 1);
	}

	// Name node (PHP)
	if (typeNode.type === "name") {
		return typeNode.text;
	}

	return undefined;
};

/**
 * Extract type arguments from a generic type node.
 * e.g., List<User, String> → ['User', 'String'], Vec<User> → ['User']
 *
 * Used by extractSimpleTypeName to unwrap nullable wrappers (Optional<User> → User).
 *
 * Handles language-specific AST structures:
 * - TS/Java/Rust/Go: generic_type > type_arguments > type nodes
 * - C#:              generic_type > type_argument_list > type nodes
 * - Kotlin:          generic_type > type_arguments > type_projection > type nodes
 *
 * Note: Go slices/maps use slice_type/map_type, not generic_type — those are
 * NOT handled here. Use language-specific extractors for Go container types.
 *
 * @param typeNode A generic_type or parameterized_type AST node (or any node —
 *   returns [] for non-generic types).
 * @returns Array of resolved type argument names. Unresolvable arguments are omitted.
 */
export const extractGenericTypeArgs = (
	typeNode: SyntaxNode,
	depth = 0,
): string[] => {
	if (depth > 50) return [];
	// Unwrap wrapper nodes that may sit above the generic_type
	if (
		typeNode.type === "type_annotation" ||
		typeNode.type === "type" ||
		typeNode.type === "user_type" ||
		typeNode.type === "nullable_type" ||
		typeNode.type === "optional_type"
	) {
		const inner = typeNode.firstNamedChild;
		if (inner) return extractGenericTypeArgs(inner, depth + 1);
		return [];
	}

	// Only process generic/parameterized type nodes (includes C#'s generic_name)
	if (
		typeNode.type !== "generic_type" &&
		typeNode.type !== "parameterized_type" &&
		typeNode.type !== "generic_name"
	) {
		return [];
	}

	// Find the type_arguments / type_argument_list child
	let argsNode: SyntaxNode | null = null;
	for (let i = 0; i < typeNode.namedChildCount; i++) {
		const child = typeNode.namedChild(i);
		if (
			child &&
			(child.type === "type_arguments" || child.type === "type_argument_list")
		) {
			argsNode = child;
			break;
		}
	}
	if (!argsNode) return [];

	const result: string[] = [];
	for (let i = 0; i < argsNode.namedChildCount; i++) {
		let argNode = argsNode.namedChild(i);
		if (!argNode) continue;

		// Kotlin: type_arguments > type_projection > user_type > type_identifier
		if (argNode.type === "type_projection") {
			argNode = argNode.firstNamedChild;
			if (!argNode) continue;
		}

		const name = extractSimpleTypeName(argNode);
		if (name) result.push(name);
	}

	return result;
};
