import { findChild, type SyntaxNode } from "../../utils/ast-helpers.js";
import {
	extractElementTypeFromString,
	extractGenericTypeArgs,
	extractSimpleTypeName,
	extractVarName,
	methodToTypeArgPosition,
	resolveIterableElementType,
	type TypeArgPosition,
} from "../shared.js";
import type {
	ClassNameLookup,
	ConstructorBindingScanner,
	ForLoopExtractor,
	InitializerExtractor,
	LanguageTypeConfig,
	ParameterExtractor,
	PatternBindingExtractor,
	PendingAssignmentExtractor,
	TypeBindingExtractor,
} from "../types.js";
import { inferJvmLiteralType } from "./literal-types.js";


// ── Java ──────────────────────────────────────────────────────────────────

const JAVA_DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
	"local_variable_declaration",
	"field_declaration",
]);

/** Java: Type x = ...; Type x; */
const extractJavaDeclaration: TypeBindingExtractor = (
	node: SyntaxNode,
	env: Map<string, string>,
): void => {
	const typeNode = node.childForFieldName("type");
	if (!typeNode) return;
	const typeName = extractSimpleTypeName(typeNode);
	if (!typeName || typeName === "var") return; // skip Java 10 var — handled by extractInitializer

	// Find variable_declarator children
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child?.type !== "variable_declarator") continue;
		const nameNode = child.childForFieldName("name");
		if (nameNode) {
			const varName = extractVarName(nameNode);
			if (varName) env.set(varName, typeName);
		}
	}
};

/** Java 10+: var x = new User() — infer type from object_creation_expression */
const extractJavaInitializer: InitializerExtractor = (
	node: SyntaxNode,
	env: Map<string, string>,
	_classNames: ClassNameLookup,
): void => {
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child?.type !== "variable_declarator") continue;
		const nameNode = child.childForFieldName("name");
		const valueNode = child.childForFieldName("value");
		if (!nameNode || !valueNode) continue;
		// Skip declarators that already have a binding from extractDeclaration
		const varName = extractVarName(nameNode);
		if (!varName || env.has(varName)) continue;
		if (valueNode.type !== "object_creation_expression") continue;
		const ctorType = valueNode.childForFieldName("type");
		if (!ctorType) continue;
		const typeName = extractSimpleTypeName(ctorType);
		if (typeName) env.set(varName, typeName);
	}
};

/** Java: formal_parameter → type name */
const extractJavaParameter: ParameterExtractor = (
	node: SyntaxNode,
	env: Map<string, string>,
): void => {
	let nameNode: SyntaxNode | null = null;
	let typeNode: SyntaxNode | null = null;

	if (node.type === "formal_parameter") {
		typeNode = node.childForFieldName("type");
		nameNode = node.childForFieldName("name");
	} else {
		// Generic fallback
		nameNode =
			node.childForFieldName("name") ?? node.childForFieldName("pattern");
		typeNode = node.childForFieldName("type");
	}

	if (!nameNode || !typeNode) return;
	const varName = extractVarName(nameNode);
	const typeName = extractSimpleTypeName(typeNode);
	if (varName && typeName) env.set(varName, typeName);
};

/** Java: var x = SomeFactory.create() — constructor binding for `var` with method_invocation */
const scanJavaConstructorBinding: ConstructorBindingScanner = (node) => {
	if (node.type !== "local_variable_declaration") return undefined;
	const typeNode = node.childForFieldName("type");
	if (!typeNode) return undefined;
	if (typeNode.text !== "var") return undefined;
	const declarator = findChild(node, "variable_declarator");
	if (!declarator) return undefined;
	const nameNode = declarator.childForFieldName("name");
	const value = declarator.childForFieldName("value");
	if (!nameNode || !value) return undefined;
	if (value.type === "object_creation_expression") return undefined;
	if (value.type !== "method_invocation") return undefined;
	const methodName = value.childForFieldName("name");
	if (!methodName) return undefined;
	return { varName: nameNode.text, calleeName: methodName.text };
};

const JAVA_FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set([
	"enhanced_for_statement",
]);

/** Extract element type from a Java type annotation AST node.
 *  Handles generic_type (List<User>), array_type (User[]). */
const extractJavaElementTypeFromTypeNode = (
	typeNode: SyntaxNode,
	pos: TypeArgPosition = "last",
): string | undefined => {
	if (typeNode.type === "generic_type") {
		const args = extractGenericTypeArgs(typeNode);
		if (args.length >= 1)
			return pos === "first" ? args[0] : args[args.length - 1];
	}
	if (typeNode.type === "array_type") {
		const elemNode = typeNode.firstNamedChild;
		if (elemNode) return extractSimpleTypeName(elemNode);
	}
	return undefined;
};

/** Walk up from a for-each to the enclosing method_declaration and search parameters. */
const findJavaParamElementType = (
	iterableName: string,
	startNode: SyntaxNode,
	pos: TypeArgPosition = "last",
): string | undefined => {
	let current: SyntaxNode | null = startNode.parent;
	while (current) {
		if (
			current.type === "method_declaration" ||
			current.type === "constructor_declaration"
		) {
			const paramsNode = current.childForFieldName("parameters");
			if (paramsNode) {
				for (let i = 0; i < paramsNode.namedChildCount; i++) {
					const param = paramsNode.namedChild(i);
					if (param?.type !== "formal_parameter") continue;
					const nameNode = param.childForFieldName("name");
					if (nameNode?.text !== iterableName) continue;
					const typeNode = param.childForFieldName("type");
					if (typeNode) return extractJavaElementTypeFromTypeNode(typeNode, pos);
				}
			}
			break;
		}
		current = current.parent;
	}
	return undefined;
};

/** Java: for (User user : users) — extract loop variable binding.
 *  Tier 1c: for `for (var user : users)`, resolves element type from iterable. */
const extractJavaForLoopBinding: ForLoopExtractor = (
	node,
	{ scopeEnv, declarationTypeNodes, scope, returnTypeLookup },
): void => {
	const typeNode = node.childForFieldName("type");
	const nameNode = node.childForFieldName("name");
	if (!typeNode || !nameNode) return;
	const varName = extractVarName(nameNode);
	if (!varName) return;

	// Explicit type (existing behavior): for (User user : users)
	const typeName = extractSimpleTypeName(typeNode);
	if (typeName && typeName !== "var") {
		scopeEnv.set(varName, typeName);
		return;
	}

	// Tier 1c: var — resolve from iterable's container type
	const iterableNode = node.childForFieldName("value");
	if (!iterableNode) return;

	let iterableName: string | undefined;
	let methodName: string | undefined;
	let callExprElementType: string | undefined;
	if (iterableNode.type === "identifier") {
		iterableName = iterableNode.text;
	} else if (iterableNode.type === "field_access") {
		const field = iterableNode.childForFieldName("field");
		if (field) iterableName = field.text;
	} else if (iterableNode.type === "method_invocation") {
		// data.keySet() → method_invocation > object: identifier + name: identifier
		// Also handles this.data.values() → object is field_access, extract inner field name
		const obj = iterableNode.childForFieldName("object");
		const name = iterableNode.childForFieldName("name");
		if (obj?.type === "identifier") {
			iterableName = obj.text;
		} else if (obj?.type === "field_access") {
			const innerField = obj.childForFieldName("field");
			if (innerField) iterableName = innerField.text;
		} else if (!obj && name) {
			// Direct function call: for (var u : getUsers()) — no receiver object
			const rawReturn = returnTypeLookup.lookupRawReturnType(name.text);
			if (rawReturn) callExprElementType = extractElementTypeFromString(rawReturn);
		}
		if (name) methodName = name.text;
	}
	if (!iterableName && !callExprElementType) return;

	let elementType: string | undefined;
	if (callExprElementType) {
		elementType = callExprElementType;
	} else {
		const containerTypeName = scopeEnv.get(iterableName!);
		const typeArgPos = methodToTypeArgPosition(methodName, containerTypeName);
		elementType = resolveIterableElementType(
			iterableName!,
			node,
			scopeEnv,
			declarationTypeNodes,
			scope,
			extractJavaElementTypeFromTypeNode,
			findJavaParamElementType,
			typeArgPos,
		);
	}
	if (elementType) scopeEnv.set(varName, elementType);
};

/** Java: var alias = u → local_variable_declaration > variable_declarator with name/value */
const extractJavaPendingAssignment: PendingAssignmentExtractor = (
	node,
	scopeEnv,
) => {
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child?.type !== "variable_declarator") continue;
		const nameNode = child.childForFieldName("name");
		const valueNode = child.childForFieldName("value");
		if (!nameNode || !valueNode) continue;
		const lhs = nameNode.text;
		if (scopeEnv.has(lhs)) continue;
		if (valueNode.type === "identifier" || valueNode.type === "simple_identifier")
			return { kind: "copy", lhs, rhs: valueNode.text };
		// field_access RHS → fieldAccess (a.field)
		if (valueNode.type === "field_access") {
			const obj = valueNode.childForFieldName("object");
			const field = valueNode.childForFieldName("field");
			if (obj?.type === "identifier" && field) {
				return { kind: "fieldAccess", lhs, receiver: obj.text, field: field.text };
			}
		}
		// method_invocation RHS
		if (valueNode.type === "method_invocation") {
			const objField = valueNode.childForFieldName("object");
			if (!objField) {
				// No receiver → callResult
				const nameField = valueNode.childForFieldName("name");
				if (nameField?.type === "identifier") {
					return { kind: "callResult", lhs, callee: nameField.text };
				}
			} else if (objField.type === "identifier") {
				// With receiver → methodCallResult
				const nameField = valueNode.childForFieldName("name");
				if (nameField?.type === "identifier") {
					return {
						kind: "methodCallResult",
						lhs,
						receiver: objField.text,
						method: nameField.text,
					};
				}
			}
		}
	}
	return undefined;
};

/**
 * Java 16+ `instanceof` pattern variable: `x instanceof User user`
 *
 * AST structure:
 *   instanceof_expression
 *     left: expression (the variable being tested)
 *     instanceof keyword
 *     right: type (the type to test against)
 *     name: identifier (the pattern variable — optional, Java 16+)
 *
 * Conservative: returns undefined when the `name` field is absent (plain instanceof
 * without pattern variable, e.g. `x instanceof User`) or when the type cannot be
 * extracted. The source variable's existing type is NOT used — the pattern explicitly
 * declares the new type, so no scopeEnv lookup is needed.
 */
const extractJavaPatternBinding: PatternBindingExtractor = (node) => {
	if (node.type === "type_pattern") {
		// Java 17+ switch pattern: case User u -> ...
		// type_pattern has positional children (NO named fields):
		//   namedChild(0) = type (type_identifier, e.g., User)
		//   namedChild(1) = identifier (e.g., u)
		const typeNode = node.namedChild(0);
		const nameNode = node.namedChild(1);
		if (!typeNode || !nameNode) return undefined;
		const typeName = extractSimpleTypeName(typeNode);
		const varName = extractVarName(nameNode);
		if (!typeName || !varName) return undefined;
		return { varName, typeName };
	}
	if (node.type !== "instanceof_expression") return undefined;
	const nameNode = node.childForFieldName("name");
	if (!nameNode) return undefined;
	const typeNode = node.childForFieldName("right");
	if (!typeNode) return undefined;
	const typeName = extractSimpleTypeName(typeNode);
	const varName = extractVarName(nameNode);
	if (!typeName || !varName) return undefined;
	return { varName, typeName };
};

/** Infer the type of a literal AST node for Java/Kotlin overload disambiguation. */

export const javaTypeConfig: LanguageTypeConfig = {
	declarationNodeTypes: JAVA_DECLARATION_NODE_TYPES,
	forLoopNodeTypes: JAVA_FOR_LOOP_NODE_TYPES,
	patternBindingNodeTypes: new Set(["instanceof_expression", "type_pattern"]),
	extractDeclaration: extractJavaDeclaration,
	extractParameter: extractJavaParameter,
	extractInitializer: extractJavaInitializer,
	scanConstructorBinding: scanJavaConstructorBinding,
	extractForLoopBinding: extractJavaForLoopBinding,
	extractPendingAssignment: extractJavaPendingAssignment,
	extractPatternBinding: extractJavaPatternBinding,
	inferLiteralType: inferJvmLiteralType,
};

// ── Kotlin ────────────────────────────────────────────────────────────────
