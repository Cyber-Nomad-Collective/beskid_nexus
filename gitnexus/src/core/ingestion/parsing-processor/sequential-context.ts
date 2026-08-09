import type { FieldExtractorContext, FieldInfo } from "../field-types.js";
import type { LanguageProvider } from "../language-provider.js";
import type { MethodInfo } from "../method-types.js";
import type { SymbolTableReader } from "../model/index.js";
import {
	CLASS_CONTAINER_TYPES,
	type EnclosingClassInfo,
	findEnclosingClassInfo,
	type SyntaxNode,
} from "../utils/ast-helpers.js";

// Sequential fallback (original implementation)
// ============================================================================

// Inline caches to avoid repeated parent-walks per node (same pattern as parse-worker.ts).
// Keyed by tree-sitter node reference — cleared at the start of each file.
export const classInfoCache = new Map<SyntaxNode, EnclosingClassInfo | null>();
export const exportCache = new Map<SyntaxNode, boolean>();

export const cachedFindEnclosingClassInfo = (
	node: SyntaxNode,
	filePath: string,
	resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null,
): EnclosingClassInfo | null => {
	const cached = classInfoCache.get(node);
	if (cached !== undefined) return cached;
	const result = findEnclosingClassInfo(node, filePath, resolveEnclosingOwner);
	classInfoCache.set(node, result);
	return result;
};

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

// FieldExtractor cache for sequential path — same pattern as parse-worker.ts
export const seqFieldInfoCache = new Map<number, Map<string, FieldInfo>>();

// MethodExtractor cache for sequential path — avoids re-traversing the same class
// body once per method. Keyed on classNode.id (tree-sitter node identity number).
export const seqMethodExtractCache = new Map<
	number,
	{ ownerName: string | undefined; methods: MethodInfo[] } | null
>();
// Derived method map + collision groups cache — avoids rebuilding per method.
export const seqMethodMapCache = new Map<
	number,
	{ map: Map<string, MethodInfo>; groups: Map<string, MethodInfo[]> }
>();

/** Provider-aware enclosing container lookup.
 *  Walks up from `node` until a CLASS_CONTAINER_TYPES node is found.
 *  When `resolveEnclosingOwner` is provided, delegates language-specific
 *  container remapping (e.g., Ruby singleton_class → enclosing class).
 *  Without the hook, returns the first matching container directly (raw lookup). */
export function seqFindEnclosingOwnerNode(
	node: SyntaxNode,
	resolveEnclosingOwner?: (node: SyntaxNode) => SyntaxNode | null,
): SyntaxNode | null {
	let current = node.parent;
	while (current) {
		if (CLASS_CONTAINER_TYPES.has(current.type)) {
			if (resolveEnclosingOwner) {
				const resolved = resolveEnclosingOwner(current);
				if (resolved === null) {
					// Provider says skip this container — keep walking up.
					current = current.parent;
					continue;
				}
				return resolved;
			}
			return current;
		}
		current = current.parent;
	}
	return null;
}

/** Minimal no-op SymbolTable stub for sequential extractor contexts. The real
 *  SymbolTable is not fully populated yet at this stage, so use the stub for safety.
 *  Implements the full {@link SymbolTableReader} surface so future extractor additions
 *  don't silently fall off an `as unknown as` cast. */
export const NOOP_SYMBOL_TABLE_SEQ: SymbolTableReader = {
	lookupExact: () => undefined,
	lookupExactFull: () => undefined,
	lookupExactAll: () => [],
	lookupCallableByName: () => [],
	getFiles: () => [][Symbol.iterator](),
	getStats: () => ({ fileCount: 0 }),
};

export function seqGetFieldInfo(
	classNode: SyntaxNode,
	provider: LanguageProvider,
	context: FieldExtractorContext,
): Map<string, FieldInfo> | undefined {
	if (!provider.fieldExtractor) return undefined;
	const cacheKey = classNode.startIndex;
	let cached = seqFieldInfoCache.get(cacheKey);
	if (cached) return cached;
	const extracted = provider.fieldExtractor.extract(classNode, context);
	if (!extracted?.fields?.length) return undefined;
	cached = new Map<string, FieldInfo>();
	for (const field of extracted.fields) cached.set(field.name, field);
	seqFieldInfoCache.set(cacheKey, cached);
	return cached;
}
