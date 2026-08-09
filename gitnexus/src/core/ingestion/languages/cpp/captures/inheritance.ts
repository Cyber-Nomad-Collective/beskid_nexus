import type { CaptureMatch } from "gitnexus-shared";
import {
	nodeToCapture,
	type SyntaxNode,
	syntheticCapture,
} from "../../../utils/ast-helpers.js";
import { markCppDependentBase } from "../two-phase-lookup.js";
import {
	findChildOfType,
	findFirstDescendantOfType,
	getTypeIdentifierName,
} from "./tree-helpers.js";

/**
 * Walk every C++ class/struct base clause and emit `@reference.inherits`
 * captures for each base so scope resolution can resolve them into EXTENDS
 * edges. Lookup names are normalized to bare class names (`Base<T>` → `Base`,
 * `outer::v1::Base<T>` → `Base`) to match the V1 simple-name
 * `findClassBindingInScope` contract. This intentionally preserves the
 * existing scope-chain tradeoff: qualified namespace context is discarded
 * here instead of introducing a C++-only name-resolution lane in shared
 * ingestion infrastructure.
 */
export function emitCppInheritanceCaptures(
	root: SyntaxNode,
	out: CaptureMatch[],
): void {
	const stack: SyntaxNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === "class_specifier" || node.type === "struct_specifier") {
			const baseClause = findChildOfType(node, ["base_class_clause"]);
			if (baseClause !== null) {
				for (const base of iterBaseClasses(baseClause)) {
					const baseName = extractBaseLookupName(base);
					if (baseName.length === 0) continue;
					out.push({
						"@reference.inherits": nodeToCapture("@reference.inherits", base),
						"@reference.name": syntheticCapture("@reference.name", base, baseName),
					});
				}
			}
		}
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child !== null) stack.push(child);
		}
	}
}

/**
 * Walk the AST finding every template_declaration containing a class or
 * struct definition with a dependent base. Records (className, baseName)
 * pairs into the module-level state via `markCppDependentBase`.
 *
 * A base is "dependent" when its name (typically a template_type like
 * `Base<T>`) uses a template parameter of the enclosing template_declaration.
 * Conservative bias: `typename T::U`, `decltype(...)` and template-template
 * parameter shapes are also treated as dependent.
 */
export function detectCppDependentBases(root: SyntaxNode, filePath: string): void {
	const stack: SyntaxNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === "template_declaration") {
			// Collect template-parameter names declared by this declaration.
			// Inner template_declarations shadow outer ones — handled by the
			// recursive descent below (each template_declaration creates its
			// own parameter scope).
			const params = collectTemplateParameterNames(node);

			// Find the class/struct definition inside this template_declaration.
			const classNode = findChildOfType(node, [
				"class_specifier",
				"struct_specifier",
			]);
			if (classNode !== null) {
				const className = getTypeIdentifierName(classNode);
				if (className !== "") {
					const baseClause = findChildOfType(classNode, ["base_class_clause"]);
					if (baseClause !== null) {
						for (const base of iterBaseClasses(baseClause)) {
							if (isBaseDependent(base, params)) {
								const baseName = extractBaseLookupName(base);
								if (baseName !== "") {
									markCppDependentBase(filePath, className, baseName);
								}
							}
						}
					}
				}
			}
		}
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child !== null) stack.push(child);
		}
	}
}

/** Collect simple template parameter names from a template_declaration. */
export function collectTemplateParameterNames(templateDecl: SyntaxNode): Set<string> {
	const names = new Set<string>();
	const paramList = findChildOfType(templateDecl, ["template_parameter_list"]);
	if (paramList === null) return names;
	for (let i = 0; i < paramList.childCount; i++) {
		const param = paramList.child(i);
		if (param === null) continue;
		if (
			param.type === "type_parameter_declaration" ||
			param.type === "optional_type_parameter_declaration" ||
			param.type === "variadic_type_parameter_declaration"
		) {
			const idNode = findFirstDescendantOfType(param, "type_identifier");
			if (idNode !== null) names.add(idNode.text);
		} else if (
			param.type === "parameter_declaration" ||
			param.type === "optional_parameter_declaration" ||
			param.type === "variadic_parameter_declaration"
		) {
			// Non-type template parameter (e.g. `template<int N>`).
			const idNode = findFirstDescendantOfType(param, "identifier");
			if (idNode !== null) names.add(idNode.text);
		} else if (param.type === "template_template_parameter_declaration") {
			// template-template parameter (e.g. `template<template<class> class TT>`)
			const idNode = findFirstDescendantOfType(param, "type_identifier");
			if (idNode !== null) names.add(idNode.text);
		}
	}
	return names;
}

/** Yield each base-class entry from a `base_class_clause`. */
export function* iterBaseClasses(
	baseClause: SyntaxNode,
): IterableIterator<SyntaxNode> {
	for (let i = 0; i < baseClause.childCount; i++) {
		const child = baseClause.child(i);
		if (child === null) continue;
		// Skip ':', ',', and access_specifier nodes — the base names are
		// type_identifier, template_type, or qualified_identifier.
		if (
			child.type === "type_identifier" ||
			child.type === "template_type" ||
			child.type === "qualified_identifier"
		) {
			yield child;
		}
	}
}

/**
 * A base is dependent when:
 *   - it's a `template_type` and its argument list contains a
 *     `type_identifier` matching one of the enclosing template's params
 *     (e.g., `Base<T>` where `T` is a template parameter), OR
 *   - it contains a `typename`, `decltype`, or `template_template_parameter`
 *     shape (conservatively treated as dependent).
 *
 * Non-dependent: `Base<int>`, `ConcreteBase`, `Base<MyConcrete>` where
 * `MyConcrete` is not a template parameter.
 */
export function isBaseDependent(
	baseNode: SyntaxNode,
	templateParams: Set<string>,
): boolean {
	if (baseNode.type !== "template_type") {
		// Bare `type_identifier` or `qualified_identifier` bases — not
		// dependent (the base name itself doesn't reference a template
		// parameter at this level).
		return false;
	}
	// Walk all descendants of the template_argument_list looking for any
	// type_identifier matching a template parameter, or any conservative-
	// dependent shape.
	const stack: SyntaxNode[] = [baseNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === "type_identifier" && templateParams.has(node.text)) {
			return true;
		}
		if (
			node.type === "decltype" ||
			node.type === "dependent_type" ||
			node.type === "template_template_parameter_declaration"
		) {
			return true;
		}
		if (node.type === "qualified_identifier") {
			// `typename T::U` or `T::nested` — if any inner identifier matches
			// a template parameter, dependent.
			for (let i = 0; i < node.childCount; i++) {
				const c = node.child(i);
				if (c !== null) stack.push(c);
			}
			continue;
		}
		for (let i = 0; i < node.childCount; i++) {
			const c = node.child(i);
			if (c !== null) stack.push(c);
		}
	}
	return false;
}

/**
 * Recursively extract the bare lookup name of a base class node.
 * Examples: `Base` → `Base`, `Base<T>` → `Base`,
 * `outer::v1::Base<T>` → `Base`. Namespace qualifiers are intentionally
 * dropped to align with V1 scope-chain lookup everywhere else in the
 * registry-primary pipeline.
 */
export function extractBaseLookupName(baseNode: SyntaxNode): string {
	if (baseNode.type === "type_identifier" || baseNode.type === "identifier")
		return baseNode.text;
	if (baseNode.type === "template_type") {
		const nameNode = baseNode.childForFieldName("name");
		if (nameNode !== null) return extractBaseLookupName(nameNode);
		const id =
			findFirstDescendantOfType(baseNode, "type_identifier") ??
			findFirstDescendantOfType(baseNode, "identifier");
		if (id !== null) return id.text;
	}
	if (baseNode.type === "qualified_identifier") {
		const nameNode = baseNode.childForFieldName("name");
		if (nameNode !== null) {
			const nested = extractBaseLookupName(nameNode);
			if (nested.length > 0) return nested;
		}
		for (let i = baseNode.childCount - 1; i >= 0; i--) {
			const child = baseNode.child(i);
			if (child === null) continue;
			const nested = extractBaseLookupName(child);
			if (nested.length > 0) return nested;
		}
	}
	return "";
}

/** Find the first direct child matching one of the given types. */
