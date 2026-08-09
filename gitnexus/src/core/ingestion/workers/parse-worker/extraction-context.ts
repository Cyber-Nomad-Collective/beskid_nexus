import {
	getLanguageFromFilename,
	SupportedLanguages,
	type NodeLabel,
} from "gitnexus-shared";
import { generateId } from "../../../../lib/utils.js";
import type { FieldExtractorContext, FieldInfo } from "../../field-types.js";
import type { LanguageProvider } from "../../language-provider.js";
import type { MethodExtractorContext, MethodInfo } from "../../method-types.js";
import type { SymbolTableReader } from "../../model/symbol-table.js";
import {
	CLASS_CONTAINER_TYPES,
	type EnclosingClassInfo,
	FUNCTION_NODE_TYPES,
	findEnclosingClassInfo,
	genericFuncName,
	inferFunctionLabel,
	type SyntaxNode,
} from "../../utils/ast-helpers.js";
import {
	buildCollisionGroups,
	constTagForId,
	typeTagForId,
} from "../../utils/method-props.js";

// ============================================================================
// Per-file O(1) memoization — avoids repeated parent-chain walks per symbol.
// Three bare Maps cleared at file boundaries. Map.get() returns undefined for
// missing keys, so `cached !== undefined` distinguishes "not computed" from
// a stored null (enclosing class/function not found = top-level).
// ============================================================================

const classIdCache = new Map<SyntaxNode, EnclosingClassInfo | null>();
const functionIdCache = new Map<SyntaxNode, string | null>();
const exportCache = new Map<SyntaxNode, boolean>();

export const clearCaches = (): void => {
	classIdCache.clear();
	functionIdCache.clear();
	exportCache.clear();
	fieldInfoCache.clear();
	methodInfoCache.clear();
};

// ============================================================================
// FieldExtractor cache — extract field metadata once per class, reuse for each property.
// Keyed by class node startIndex (unique per AST node within a file).
// ============================================================================

const fieldInfoCache = new Map<number, Map<string, FieldInfo>>();

/**
 * Walk up from a definition node to find the nearest enclosing class/struct/interface
 * AST node. Returns the SyntaxNode itself (not an ID) for passing to FieldExtractor.
 */
export function findEnclosingClassNode(node: SyntaxNode): SyntaxNode | null {
	let current = node.parent;
	while (current) {
		if (CLASS_CONTAINER_TYPES.has(current.type)) {
			// Return singleton_class directly so the method extractor sees it as
			// the owner node and correctly marks methods as static. Name resolution
			// for qualified names is handled separately by findEnclosingClassInfo.
			return current;
		}
		current = current.parent;
	}
	return null;
}

/**
 * For C++ out-of-class method definitions (e.g. `void Foo::bar() {}`), extract the
 * class name from the qualified_identifier scope and find the class declaration in the
 * file's AST. Returns the class SyntaxNode or null if not found.
 *
 * Handles pointer/reference return types where function_declarator is nested inside
 * pointer_declarator or reference_declarator.
 */
export function findClassNodeByQualifiedName(node: SyntaxNode): SyntaxNode | null {
	const declarator = node.childForFieldName("declarator");
	if (!declarator) return null;

	// Find the function_declarator, recursively unwrapping pointer_declarator /
	// reference_declarator chains (e.g. int** Foo::bar() has
	// pointer_declarator → pointer_declarator → function_declarator).
	let funcDecl: SyntaxNode | null = null;
	if (declarator.type === "function_declarator") {
		funcDecl = declarator;
	} else {
		let current: SyntaxNode | null = declarator;
		while (current && !funcDecl) {
			for (let i = 0; i < current.namedChildCount; i++) {
				const child = current.namedChild(i);
				if (child?.type === "function_declarator") {
					funcDecl = child;
					break;
				}
			}
			if (!funcDecl) {
				const next = current.namedChildren.find(
					(c) =>
						c.type === "pointer_declarator" || c.type === "reference_declarator",
				);
				current = next ?? null;
			}
		}
	}
	if (!funcDecl) return null;

	// Check if the inner declarator is a qualified_identifier (Foo::bar)
	const innerDecl = funcDecl.childForFieldName("declarator");
	if (innerDecl?.type !== "qualified_identifier") return null;

	const scope = innerDecl.childForFieldName("scope");
	if (!scope) return null;
	const className = scope.text;

	// Search the file for a matching class/struct specifier, including inside
	// namespace_definition blocks (the majority of production C++ uses namespaces).
	const root = node.tree.rootNode;
	const classTypes = new Set(["class_specifier", "struct_specifier"]);
	const searchIn = (parent: SyntaxNode): SyntaxNode | null => {
		for (let i = 0; i < parent.namedChildCount; i++) {
			const child = parent.namedChild(i);
			if (!child) continue;
			if (classTypes.has(child.type)) {
				const nameNode = child.childForFieldName("name");
				if (nameNode?.text === className) return child;
			}
			// Recurse into namespace blocks
			if (child.type === "namespace_definition") {
				const found = searchIn(child);
				if (found) return found;
			}
		}
		return null;
	};
	return searchIn(root);
}

/**
 * Minimal no-op SymbolTable stub for FieldExtractorContext in the worker.
 * Field extraction only uses symbolTable.lookupExactAll for optional type
 * resolution — returning [] causes the extractor to use the raw type
 * string, which is fine for us. Every other method is a no-op so the
 * stub remains safe if a future FieldExtractor consults it through the
 * full {@link SymbolTableReader} surface.
 */
export const NOOP_SYMBOL_TABLE: SymbolTableReader = {
	lookupExact: () => undefined,
	lookupExactFull: () => undefined,
	lookupExactAll: () => [],
	lookupCallableByName: () => [],
	getFiles: () => [][Symbol.iterator](),
	getStats: () => ({ fileCount: 0 }),
};

/**
 * Get (or extract and cache) field info for a class node.
 * Returns a name→FieldInfo map, or undefined if the provider has no field extractor
 * or the class yielded no fields.
 */
export function getFieldInfo(
	classNode: SyntaxNode,
	provider: LanguageProvider,
	context: FieldExtractorContext,
): Map<string, FieldInfo> | undefined {
	if (!provider.fieldExtractor) return undefined;

	const cacheKey = classNode.startIndex;
	let cached = fieldInfoCache.get(cacheKey);
	if (cached) return cached;

	const result = provider.fieldExtractor.extract(classNode, context);
	if (!result?.fields?.length) return undefined;

	cached = new Map<string, FieldInfo>();
	for (const field of result.fields) {
		cached.set(field.name, field);
	}
	fieldInfoCache.set(cacheKey, cached);
	return cached;
}

// ============================================================================
// MethodExtractor cache — extract method metadata once per class, reuse for each method.
// Keyed by class node startIndex (unique per AST node within a file).
// ============================================================================

const methodInfoCache = new Map<number, Map<string, MethodInfo>>();

/**
 * Get (or extract and cache) method info for a class node.
 * Returns a "name:line" → MethodInfo map, or undefined if the provider has no method extractor
 * or the class yielded no methods.
 * Keyed by name:line (not name alone) to support overloaded methods in Java/Kotlin.
 */
export function getMethodInfo(
	classNode: SyntaxNode,
	provider: LanguageProvider,
	context: MethodExtractorContext,
): Map<string, MethodInfo> | undefined {
	if (!provider.methodExtractor) return undefined;

	const cacheKey = classNode.startIndex;
	let cached = methodInfoCache.get(cacheKey);
	if (cached) return cached;

	const result = provider.methodExtractor.extract(classNode, context);
	if (!result?.methods?.length) return undefined;

	cached = new Map<string, MethodInfo>();
	for (const method of result.methods) {
		cached.set(`${method.name}:${method.line}`, method);
	}
	methodInfoCache.set(cacheKey, cached);
	return cached;
}

// ============================================================================
// Enclosing function detection (for call extraction) — cached
// ============================================================================

/** Walk up AST to find enclosing function, return its generateId or null for top-level.
 *  Applies provider.labelOverride so the label matches the definition phase (single source of truth). */
export const findEnclosingFunctionId = (
	node: SyntaxNode,
	filePath: string,
	provider: LanguageProvider,
): string | null => {
	const cached = functionIdCache.get(node);
	if (cached !== undefined) return cached;

	let current = node.parent;
	while (current) {
		if (FUNCTION_NODE_TYPES.has(current.type)) {
			const efnResult = provider.methodExtractor?.extractFunctionName?.(current);
			const funcName = efnResult?.funcName ?? genericFuncName(current);
			const label = efnResult?.label ?? inferFunctionLabel(current.type);
			if (funcName) {
				// Apply labelOverride so label matches definition phase (e.g., Kotlin Function→Method).
				// null means "skip as definition" — keep original label for scope identification.
				let finalLabel = label;
				if (provider.labelOverride) {
					const override = provider.labelOverride(current, label);
					if (override !== null) finalLabel = override;
				}
				// Qualify with enclosing class to match definition-phase node IDs
				const classInfo = cachedFindEnclosingClassInfo(
					current,
					filePath,
					provider.resolveEnclosingOwner,
				);
				const encLang = getLanguageFromFilename(filePath);
				const standaloneMethodInfo =
					(finalLabel === "Method" || finalLabel === "Constructor") &&
					encLang === SupportedLanguages.Go &&
					provider.methodExtractor?.extractFromNode
						? provider.methodExtractor.extractFromNode(current, {
								filePath,
								language: encLang,
							})
						: null;
				const ownerName =
					classInfo?.className ?? standaloneMethodInfo?.receiverType ?? undefined;
				const qualifiedName = ownerName ? `${ownerName}.${funcName}` : funcName;
				// Include #<arity> suffix to match definition-phase Method/Constructor IDs.
				// Use the same MethodExtractor (getMethodInfo) as the definition phase.
				// When same-arity collisions exist, also append ~type1,type2.
				let arity: number | undefined;
				let encTypeTag = "";
				if (finalLabel === "Method" || finalLabel === "Constructor") {
					if (standaloneMethodInfo) {
						arity = standaloneMethodInfo.parameters.some((p) => p.isVariadic)
							? undefined
							: standaloneMethodInfo.parameters.length;
					} else {
						const classNode =
							findEnclosingClassNode(current) ?? findClassNodeByQualifiedName(current);
						if (classNode && encLang) {
							const methodMap = getMethodInfo(classNode, provider, {
								filePath,
								language: encLang,
							});
							const defLine = current.startPosition.row + 1;
							const info = methodMap?.get(`${funcName}:${defLine}`);
							if (info) {
								arity = info.parameters.some((p) => p.isVariadic)
									? undefined
									: info.parameters.length;
								if (methodMap && arity !== undefined) {
									const g = buildCollisionGroups(methodMap);
									encTypeTag =
										typeTagForId(methodMap, funcName, arity, info, encLang, g) +
										constTagForId(methodMap, funcName, arity, info, g);
								}
							}
						}
					}
				}
				const arityTag = arity !== undefined ? `#${arity}${encTypeTag}` : "";
				const result = generateId(
					finalLabel,
					`${filePath}:${qualifiedName}${arityTag}`,
				);
				functionIdCache.set(node, result);
				return result;
			}
		}

		// Language-specific enclosing function resolution (e.g., Dart where
		// function_body is a sibling of function_signature, not a child).
		if (provider.enclosingFunctionFinder) {
			const customResult = provider.enclosingFunctionFinder(current);
			if (customResult) {
				let finalLabel: NodeLabel = customResult.label;
				if (provider.labelOverride) {
					const override = provider.labelOverride(
						current.previousSibling,
						finalLabel,
					);
					if (override !== null) finalLabel = override;
				}
				// Qualify custom result with enclosing class
				const classInfo = cachedFindEnclosingClassInfo(
					current.previousSibling ?? current,
					filePath,
					provider.resolveEnclosingOwner,
				);
				const qualifiedName = classInfo
					? `${classInfo.className}.${customResult.funcName}`
					: customResult.funcName;
				// Include #<arity> suffix to match definition-phase Method/Constructor IDs.
				// When same-arity collisions exist, also append ~type1,type2.
				const sigNode = current.previousSibling ?? current;
				let arity2: number | undefined;
				let encTypeTag2 = "";
				if (finalLabel === "Method" || finalLabel === "Constructor") {
					const encLang2 = getLanguageFromFilename(filePath);
					const classNode2 =
						findEnclosingClassNode(sigNode) ?? findClassNodeByQualifiedName(sigNode);
					if (classNode2 && encLang2) {
						const methodMap2 = getMethodInfo(classNode2, provider, {
							filePath,
							language: encLang2,
						});
						const defLine2 = sigNode.startPosition.row + 1;
						const info2 = methodMap2?.get(`${customResult.funcName}:${defLine2}`);
						if (info2) {
							arity2 = info2.parameters.some((p) => p.isVariadic)
								? undefined
								: info2.parameters.length;
							if (methodMap2 && arity2 !== undefined) {
								const g2 = buildCollisionGroups(methodMap2);
								encTypeTag2 =
									typeTagForId(
										methodMap2,
										customResult.funcName,
										arity2,
										info2,
										encLang2,
										g2,
									) +
									constTagForId(methodMap2, customResult.funcName, arity2, info2, g2);
							}
						}
					}
				}
				const arityTag2 = arity2 !== undefined ? `#${arity2}${encTypeTag2}` : "";
				const result = generateId(
					finalLabel,
					`${filePath}:${qualifiedName}${arityTag2}`,
				);
				functionIdCache.set(node, result);
				return result;
			}
		}

		current = current.parent;
	}
	functionIdCache.set(node, null);
	return null;
};

/** Cached wrapper for findEnclosingClassInfo — avoids repeated parent walks. */
export const cachedFindEnclosingClassInfo = (
	node: SyntaxNode,
	filePath: string,
	resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null,
): EnclosingClassInfo | null => {
	const cached = classIdCache.get(node);
	if (cached !== undefined) return cached;

	const result = findEnclosingClassInfo(node, filePath, resolveEnclosingOwner);
	classIdCache.set(node, result);
	return result;
};

/** Cached wrapper for export checking — avoids repeated parent walks per symbol. */
export const cachedExportCheck = (
	checker: (node: SyntaxNode, name: string) => boolean,
	node: SyntaxNode,
	name: string,
): boolean => {
	const cached = exportCache.get(node);
	if (cached !== undefined) return cached;

	const result = checker(node, name);
	exportCache.set(node, result);
	return result;
};

// Label detection moved to shared getLabelFromCaptures in utils.ts

// DEFINITION_CAPTURE_KEYS and getDefinitionNodeFromCaptures imported from ../utils.js
