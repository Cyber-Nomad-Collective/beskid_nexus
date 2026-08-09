import type { CppAdlArgInfo } from "../adl.js";
import type { SyntaxNode } from "../../../utils/ast-helpers.js";
import { extractDeclaratorLeafName } from "./declarations.js";
import {
	findChildOfType,
	findFirstDescendantOfType,
} from "./tree-helpers.js";

export function isInlineNamespace(nsNode: SyntaxNode): boolean {
	for (let i = 0; i < nsNode.childCount; i++) {
		const c = nsNode.child(i);
		if (c === null) continue;
		if (c.type === "inline") return true;
		// Some grammar variants surface keywords by their text rather than
		// by a dedicated node type; check both for resilience.
		if (
			c.text === "inline" &&
			(c.type === "storage_class_specifier" || c.type === "inline")
		) {
			return true;
		}
	}
	return false;
}

/**
 * Detect `(f)(args)` shape — the call-expression's `function` field is a
 * `parenthesized_expression`. ISO C++ specifies that this form suppresses
 * ADL (`[basic.lookup.argdep]/3.1`): the parenthesized name is treated as
 * an ordinary unqualified-lookup-only callee.
 */
export function isParenthesizedFunctionCall(callNode: SyntaxNode): boolean {
	const fn = callNode.childForFieldName("function");
	return fn !== null && fn.type === "parenthesized_expression";
}

/**
 * Per-argument ADL classification: walk each argument of a free call and
 * classify its declared type for associated-namespace lookup.
 *
 * Value/pointer/reference class-typed args and template specializations
 * with explicit type arguments contribute; function pointers, primitives,
 * literals, and other unsupported shapes produce an empty result.
 *
 * Class-typed values/pointers/references (`N::S`, `N::S*`, `N::S&`) all
 * preserve the class name for associated-namespace lookup.
 * Function pointers remain excluded even when their return type names a
 * class, because the associated entity is the pointed-to function type,
 * not the return type.
 */
export function inferCppCallAdlArgs(callNode: SyntaxNode): CppAdlArgInfo[] {
	const argList = callNode.childForFieldName("arguments");
	if (argList === null) return [];
	const out: CppAdlArgInfo[] = [];
	for (let i = 0; i < argList.childCount; i++) {
		const child = argList.child(i);
		if (child === null) continue;
		if (child.type === "," || child.type === "(" || child.type === ")") continue;
		out.push(classifyAdlArg(child));
	}
	return out;
}

export const ADL_TEMPLATE_RECURSION_MAX_DEPTH = 8;
export const EMPTY_ADL_ARG: CppAdlArgInfo = {
	simpleClassName: "",
	templateSimpleClassName: "",
	templateNamespace: "",
	templateArgClassNames: [],
	templateArgNamespaces: [],
};

export function classifyAdlArg(argNode: SyntaxNode): CppAdlArgInfo {
	// Literals and primitive-shaped expressions never have associated namespaces.
	if (
		argNode.type === "number_literal" ||
		argNode.type === "string_literal" ||
		argNode.type === "raw_string_literal" ||
		argNode.type === "char_literal" ||
		argNode.type === "true" ||
		argNode.type === "false" ||
		argNode.type === "null" ||
		argNode.type === "nullptr"
	) {
		return EMPTY_ADL_ARG;
	}
	// Qualified expression (a::b) — may be a function, variable, enum value,
	// or static member. Record as a potential function reference; resolution
	// time verifies via workspace lookup that a Function/Method with this simple
	// name exists in the extracted namespace before contributing to the set.
	if (argNode.type === "qualified_identifier") {
		return {
			simpleClassName: "",
			templateSimpleClassName: "",
			templateNamespace: "",
			templateArgClassNames: [],
			templateArgNamespaces: [],
			functionRefText: argNode.text,
		};
	}
	// Variable reference — look up its declared type (preserving pointer /
	// reference / qualified-name shape; the existing arity-narrowing helper
	// strips this info).
	if (argNode.type === "identifier") {
		const result = lookupAdlIdentifierType(argNode);
		if (result === null) {
			// Not found in the local compound_statement scope — could be a
			// free-function reference (unqualified name, namespace scope).
			return {
				simpleClassName: "",
				templateSimpleClassName: "",
				templateNamespace: "",
				templateArgClassNames: [],
				templateArgNamespaces: [],
				functionRefText: argNode.text,
			};
		}
		return result;
	}
	// Other shapes (calls, member access, operators) — V1 unsupported.
	return EMPTY_ADL_ARG;
}

/**
 * Returns `true` when `varName` appears as a parameter name in the nearest
 * enclosing `function_definition` or `function_declarator` that contains
 * `identNode`. Parameters live in `parameter_list` (a sibling of the
 * `compound_statement`), so the `compound_statement`-local declaration scan
 * in `lookupAdlIdentifierType` would not find them — causing them to be
 * mistakenly classified as potential free-function references.
 *
 * In tree-sitter-cpp a `function_definition` does NOT expose `parameters`
 * as a direct named field; parameters live inside the nested
 * `function_declarator`. For `function_declarator` nodes the `parameters`
 * field IS direct. Both cases are handled below.
 */
export function isIdentifierAFunctionParameter(
	identNode: SyntaxNode,
	varName: string,
): boolean {
	let node: SyntaxNode | null = identNode.parent;
	let safety = 64;
	while (node !== null && safety-- > 0) {
		let params: SyntaxNode | null = null;
		if (node.type === "function_declarator") {
			// parameters is a direct field on function_declarator.
			params = node.childForFieldName("parameters");
		} else if (node.type === "function_definition") {
			// function_definition carries parameters inside its `declarator` field
			// (which is a function_declarator). Walk through it.
			const decl = node.childForFieldName("declarator");
			if (decl !== null && decl.type === "function_declarator") {
				params = decl.childForFieldName("parameters");
			}
		}
		if (params !== null) {
			for (let i = 0; i < params.namedChildCount; i++) {
				const param = params.namedChild(i);
				if (param === null) continue;
				const declNode = param.childForFieldName("declarator");
				if (declNode === null) continue;
				const leafName = extractDeclaratorLeafName(declNode);
				if (leafName === varName) return true;
			}
			// Only check the immediately enclosing function — do not climb further.
			break;
		}
		if (node.type === "translation_unit") break;
		node = node.parent;
	}
	return false;
}

export function lookupAdlIdentifierType(identNode: SyntaxNode): CppAdlArgInfo | null {
	const varName = identNode.text;
	let scope: SyntaxNode | null = identNode.parent;
	while (
		scope !== null &&
		scope.type !== "compound_statement" &&
		scope.type !== "translation_unit"
	) {
		scope = scope.parent;
	}
	if (scope === null) return null;

	// Function parameters live in the enclosing function's `parameter_list`,
	// NOT inside the `compound_statement`, so the declaration scan below would
	// never find them and would return `null` — incorrectly triggering the
	// free-function-reference path. Check the parameter_list first.
	if (isIdentifierAFunctionParameter(identNode, varName)) {
		return EMPTY_ADL_ARG;
	}

	let foundAsLocalFunctionPointer = false;
	for (let i = 0; i < scope.childCount; i++) {
		const stmt = scope.child(i);
		if (stmt === null || stmt.type !== "declaration") continue;
		const typeNode = stmt.childForFieldName("type");
		if (typeNode === null) continue;
		if (typeNode.type === "placeholder_type_specifier") continue;

		const declarator = stmt.childForFieldName("declarator");
		if (declarator === null) continue;

		// Unwrap declarator chain to find pointer/reference markers and the
		// variable name. `init_declarator > pointer_declarator > identifier`
		// means pointer-typed; repeated pointer wrappers still count as pointer
		// typed; `init_declarator > reference_declarator > ...` (or
		// `rvalue_reference_declarator`) means reference-typed; bare
		// `init_declarator > identifier` is value.
		// Function-pointer wrappers (`pointer_declarator > function_declarator`)
		// must not contribute ADL associated namespaces.
		let isFunctionPointer = false;
		let inner: SyntaxNode = declarator;
		let nameText: string | null = null;
		let safety = 16; // bound walk depth defensively
		while (safety-- > 0) {
			if (inner.type === "pointer_declarator") {
				if (findFirstDescendantOfType(inner, "function_declarator") !== null) {
					isFunctionPointer = true;
					// Extract the name from within the function-pointer declarator chain
					// so `foundAsLocalFunctionPointer` can detect a matching declaration.
					nameText = extractDeclaratorLeafName(inner);
					break;
				}
				const next = inner.childForFieldName("declarator");
				if (next === null) break;
				inner = next;
				continue;
			}
			if (
				inner.type === "reference_declarator" ||
				inner.type === "rvalue_reference_declarator"
			) {
				// reference_declarator has a single child (the inner declarator).
				let next: SyntaxNode | null = null;
				for (let j = 0; j < inner.namedChildCount; j++) {
					const c = inner.namedChild(j);
					if (c !== null) {
						next = c;
						break;
					}
				}
				if (next === null) break;
				inner = next;
				continue;
			}
			if (inner.type === "init_declarator") {
				const next = inner.childForFieldName("declarator");
				if (next === null) break;
				inner = next;
				continue;
			}
			if (inner.type === "function_declarator") {
				isFunctionPointer = true;
				// Extract the name from the inner declarator (e.g. `(*g)` in `void (*g)()`).
				const innerDecl = inner.childForFieldName("declarator");
				if (innerDecl !== null) nameText = extractDeclaratorLeafName(innerDecl);
				break;
			}
			// Reached the leaf — usually `identifier`. Take its text.
			nameText = inner.text;
			break;
		}
		if (nameText === varName && isFunctionPointer) {
			// Explicitly declared as a function-pointer variable — must not be
			// treated as a free-function reference by the caller.
			foundAsLocalFunctionPointer = true;
			continue;
		}
		if (isFunctionPointer || nameText !== varName) continue;

		const simpleClassName = extractAdlSimpleTypeName(typeNode);
		const {
			templateSimpleClassName,
			templateNamespace,
			templateArgClassNames,
			templateArgNamespaces,
		} = extractAdlTemplateInfo(typeNode);
		return {
			simpleClassName,
			templateSimpleClassName,
			templateNamespace,
			templateArgClassNames,
			templateArgNamespaces,
		};
	}
	// If the identifier was found in local scope as a function-pointer variable,
	// return EMPTY_ADL_ARG so the caller does NOT treat it as a free-function
	// reference. Otherwise return null to indicate "not in local scope".
	//
	// Known limitation (Finding 4): variables whose type is a typedef/using alias
	// for a function-pointer type are NOT detected here. For example:
	//   using Callback = void (*)();
	//   Callback g;
	//   foo(g);  // `g`'s declarator is `identifier` with type `Callback`
	// The declarator has no `pointer_declarator` wrapper, so `isFunctionPointer`
	// stays false and `extractAdlSimpleTypeName` returns `"Callback"`. ADL then
	// looks for a class named `Callback`; if none exists, this degrades to
	// EMPTY_ADL_ARG (class not found → no namespace contributed). If a class
	// named `Callback` does exist, a spurious namespace contribution could occur.
	// Risk is low in practice; a future fix should resolve the typedef/alias chain.
	return foundAsLocalFunctionPointer ? EMPTY_ADL_ARG : null;
}

/** Extract the simple class-like type name from a `type:` field node.
 *  Returns '' for primitives and any other
 *  unsupported type-only shape. Function pointers are filtered at the
 *  declarator level in `lookupAdlIdentifierType`. */
export function extractAdlSimpleTypeName(typeNode: SyntaxNode): string {
	if (typeNode.type === "type_descriptor") {
		const innerType = typeNode.childForFieldName("type");
		if (innerType !== null) return extractAdlSimpleTypeName(innerType);
		for (let i = 0; i < typeNode.childCount; i++) {
			const child = typeNode.child(i);
			if (child === null) continue;
			if (
				child.type === "type_identifier" ||
				child.type === "qualified_identifier" ||
				child.type === "template_type"
			) {
				return extractAdlSimpleTypeName(child);
			}
		}
		return "";
	}
	if (typeNode.type === "primitive_type") return "";
	if (typeNode.type === "sized_type_specifier") return "";
	if (typeNode.type === "type_identifier") return typeNode.text;
	if (typeNode.type === "template_type") {
		const nameNode = typeNode.childForFieldName("name");
		if (nameNode !== null) return extractAdlSimpleTypeName(nameNode);
		const id = findFirstDescendantOfType(typeNode, "type_identifier");
		return id !== null ? id.text : "";
	}
	if (typeNode.type === "qualified_identifier") {
		const nameNode = typeNode.childForFieldName("name");
		if (nameNode !== null) return extractAdlSimpleTypeName(nameNode);
		const id = findFirstDescendantOfType(typeNode, "type_identifier");
		return id !== null ? id.text : "";
	}
	// Function pointers, decltype, etc — unsupported for ADL participation.
	return "";
}

export function extractAdlTypeNamespace(typeNode: SyntaxNode): string {
	if (typeNode.type === "type_descriptor") {
		const innerType = typeNode.childForFieldName("type");
		if (innerType !== null) return extractAdlTypeNamespace(innerType);
		for (let i = 0; i < typeNode.childCount; i++) {
			const child = typeNode.child(i);
			if (child === null) continue;
			if (
				child.type === "qualified_identifier" ||
				child.type === "template_type" ||
				child.type === "type_identifier"
			) {
				return extractAdlTypeNamespace(child);
			}
		}
		return "";
	}
	if (typeNode.type === "template_type") {
		const nameNode = typeNode.childForFieldName("name");
		return nameNode !== null ? extractAdlTypeNamespace(nameNode) : "";
	}
	if (typeNode.type === "qualified_identifier") {
		const scope = typeNode.childForFieldName("scope");
		if (scope !== null) return normalizeCppNamespaceQName(scope.text);
		return extractNamespaceFromQualifiedText(typeNode.text);
	}
	return "";
}

export function extractAdlTemplateInfo(typeNode: SyntaxNode): {
	templateSimpleClassName: string;
	templateNamespace: string;
	templateArgClassNames: string[];
	templateArgNamespaces: string[];
} {
	const templateTypeNode = findTemplateTypeNode(typeNode);
	if (templateTypeNode === null) {
		return {
			templateSimpleClassName: "",
			templateNamespace: "",
			templateArgClassNames: [],
			templateArgNamespaces: [],
		};
	}
	const templateArgClassNames: string[] = [];
	const templateArgNamespaces: string[] = [];
	collectAdlTemplateArgs(
		templateTypeNode,
		0,
		templateArgClassNames,
		templateArgNamespaces,
	);
	return {
		templateSimpleClassName: extractAdlSimpleTypeName(templateTypeNode),
		templateNamespace: extractAdlTypeNamespace(typeNode),
		templateArgClassNames,
		templateArgNamespaces,
	};
}

export function collectAdlTemplateArgs(
	templateTypeNode: SyntaxNode,
	depth: number,
	outClassNames: string[],
	outNamespaces: string[],
): void {
	if (depth >= ADL_TEMPLATE_RECURSION_MAX_DEPTH) return;
	if (templateTypeNode.type !== "template_type") return;

	const argList =
		templateTypeNode.childForFieldName("arguments") ??
		findChildOfType(templateTypeNode, ["template_argument_list"]);
	if (argList === null) return;

	for (let i = 0; i < argList.namedChildCount; i++) {
		const arg = argList.namedChild(i);
		if (arg === null || arg.type !== "type_descriptor") continue;
		const simpleClassName = extractAdlSimpleTypeName(arg);
		if (simpleClassName.length > 0) outClassNames.push(simpleClassName);
		const ns = extractAdlTypeNamespace(arg);
		if (ns.length > 0) outNamespaces.push(ns);

		const nestedType = arg.childForFieldName("type");
		const nestedTemplate =
			nestedType !== null ? findTemplateTypeNode(nestedType) : null;
		if (nestedTemplate !== null) {
			collectAdlTemplateArgs(
				nestedTemplate,
				depth + 1,
				outClassNames,
				outNamespaces,
			);
		}
	}
}

export function findTemplateTypeNode(typeNode: SyntaxNode): SyntaxNode | null {
	if (typeNode.type === "template_type") return typeNode;
	if (typeNode.type === "type_descriptor") {
		const innerType = typeNode.childForFieldName("type");
		if (innerType !== null) return findTemplateTypeNode(innerType);
		return null;
	}
	if (typeNode.type === "qualified_identifier") {
		const nameNode = typeNode.childForFieldName("name");
		if (nameNode !== null) return findTemplateTypeNode(nameNode);
		return null;
	}
	return null;
}

export function normalizeCppNamespaceQName(text: string): string {
	const normalized = text
		.replace(/^::/, "")
		.replace(/::$/, "")
		.replace(/::/g, ".");
	return normalized;
}

export function extractNamespaceFromQualifiedText(text: string): string {
	const cleaned = text.replace(/\s+/g, "");
	const idx = cleaned.lastIndexOf("::");
	if (idx <= 0) return "";
	return normalizeCppNamespaceQName(cleaned.slice(0, idx));
}
