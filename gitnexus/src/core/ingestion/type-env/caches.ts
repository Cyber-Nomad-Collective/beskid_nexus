import type { SemanticModel } from "../model/index.js";
import type { ClassNameLookup } from "../type-extractors/types.js";
import {
	CLASS_CONTAINER_TYPES,
	type SyntaxNode,
} from "../utils/ast-helpers.js";
import {
	extractParentClassFromNode,
	findTypeIdentifierChild,
} from "./language-normalization.js";

/** Per-file memoization caches for expensive parent-walk functions.
 *  Cleared at the start of each buildTypeEnv call (one call per file). */
export const enclosingClassNameCache = new Map<SyntaxNode, string | undefined>();
export const enclosingParentClassNameCache = new Map<SyntaxNode, string | undefined>();

/**
 * Walk up the AST from a node to find the enclosing class/module name.
 * Used to resolve `self`/`this` receivers to their containing type.
 * Memoized per-file: cache is cleared at buildTypeEnv entry.
 */
export const findEnclosingClassName = (node: SyntaxNode): string | undefined => {
	if (enclosingClassNameCache.has(node))
		return enclosingClassNameCache.get(node);
	let current = node.parent;
	while (current) {
		if (CLASS_CONTAINER_TYPES.has(current.type)) {
			const nameNode =
				current.childForFieldName("name") ?? findTypeIdentifierChild(current);
			if (nameNode) {
				enclosingClassNameCache.set(node, nameNode.text);
				return nameNode.text;
			}
		}
		current = current.parent;
	}
	enclosingClassNameCache.set(node, undefined);
	return undefined;
};

/**
 * Walk up the AST to find the enclosing class, then extract its parent class name
 * from the heritage/superclass AST node. Used to resolve `super`/`base`/`parent`.
 *
 * Supported patterns per tree-sitter grammar:
 * - Java/Ruby: `superclass` field → type_identifier/constant
 * - Python: `superclasses` field → argument_list → first identifier
 * - TypeScript/JS: unnamed `class_heritage` child → `extends_clause` → identifier
 * - C#: unnamed `base_list` child → first identifier
 * - PHP: unnamed `base_clause` child → name
 * - Kotlin: unnamed `delegation_specifier` child → constructor_invocation → user_type → type_identifier
 * - C++: unnamed `base_class_clause` child → type_identifier
 * - Swift: unnamed `inheritance_specifier` child → user_type → type_identifier
 */
export const findEnclosingParentClassName = (node: SyntaxNode): string | undefined => {
	if (enclosingParentClassNameCache.has(node))
		return enclosingParentClassNameCache.get(node);
	let current = node.parent;
	while (current) {
		if (CLASS_CONTAINER_TYPES.has(current.type)) {
			const result = extractParentClassFromNode(current);
			enclosingParentClassNameCache.set(node, result);
			return result;
		}
		current = current.parent;
	}
	enclosingParentClassNameCache.set(node, undefined);
	return undefined;
};

/**
 * Create a lookup that checks both local AST class names AND the SymbolTable's
 * global index. This allows extractInitializer functions to distinguish
 * constructor calls from function calls (e.g. Kotlin `User()` vs `getUser()`)
 * using cross-file type information when available.
 *
 * Only `.has()` is exposed — the SymbolTable doesn't support iteration.
 * Results are memoized to avoid redundant class-index scans across declarations.
 */
export const createClassNameLookup = (
	localNames: Set<string>,
	model?: SemanticModel,
): ClassNameLookup => {
	if (!model) return localNames;

	const memo = new Map<string, boolean>();
	return {
		has(name: string): boolean {
			if (localNames.has(name)) return true;
			const cached = memo.get(name);
			if (cached !== undefined) return cached;
			const result = model.types
				.lookupClassByName(name)
				.some(
					(def) =>
						def.type === "Class" || def.type === "Enum" || def.type === "Struct",
				);
			memo.set(name, result);
			return result;
		},
	};
};

