import type { NodeLabel } from "gitnexus-shared";
import type { PendingAssignment } from "../type-extractors/types.js";
import {
	FUNCTION_NODE_TYPES,
	genericFuncName,
	type SyntaxNode,
} from "../utils/ast-helpers.js";
import {
	FILE_SCOPE,
	type PatternOverrides,
	type TypeEnv,
} from "./contracts.js";
import {
	findEnclosingClassName,
	findEnclosingParentClassName,
} from "./caches.js";
import { fastStripNullable } from "./language-normalization.js";

export const lookupInEnv = (
	env: TypeEnv,
	varName: string,
	callNode: SyntaxNode,
	patternOverrides?: PatternOverrides,
	enclosingFunctionFinder?: (
		n: SyntaxNode,
	) => { funcName: string; label: NodeLabel } | null,
	extractFunctionNameHook?: (
		n: SyntaxNode,
	) => { funcName: string | null; label: NodeLabel } | null,
): string | undefined => {
	// Self/this receiver: resolve to enclosing class name via AST walk
	if (varName === "self" || varName === "this" || varName === "$this") {
		return findEnclosingClassName(callNode);
	}

	// Super/base/parent receiver: resolve to the parent class name via AST walk.
	// Walks up to the enclosing class, then extracts the superclass from its heritage node.
	if (varName === "super" || varName === "base" || varName === "parent") {
		return findEnclosingParentClassName(callNode);
	}

	// Determine the enclosing function scope for the call
	const scopeKey = findEnclosingScopeKey(
		callNode,
		enclosingFunctionFinder,
		extractFunctionNameHook,
	);

	// Check position-indexed pattern overrides first (e.g., Kotlin when/is smart casts).
	// These take priority over flat scopeEnv because they represent per-branch narrowing.
	if (scopeKey && patternOverrides) {
		const varOverrides = patternOverrides.get(scopeKey)?.get(varName);
		if (varOverrides) {
			const pos = callNode.startIndex;
			for (const override of varOverrides) {
				if (pos >= override.rangeStart && pos <= override.rangeEnd) {
					return fastStripNullable(override.typeName);
				}
			}
		}
	}

	// Try function-local scope first
	if (scopeKey) {
		const scopeEnv = env.get(scopeKey);
		if (scopeEnv) {
			const result = scopeEnv.get(varName);
			if (result) return fastStripNullable(result);
		}
	}

	// Fall back to file-level scope
	const fileEnv = env.get(FILE_SCOPE);
	const raw = fileEnv?.get(varName);
	return raw ? fastStripNullable(raw) : undefined;
};
/** Keywords that refer to the current instance across languages. */
const THIS_RECEIVERS = new Set(["this", "self", "$this", "Me"]);

/**
 * If a pending assignment's receiver is this/self/$this/Me, substitute the
 * enclosing class name. Returns the item unchanged for non-receiver kinds
 * or when the receiver is not a this-keyword. Properties are readonly in the
 * discriminated union, so a new object is returned when substitution occurs.
 */
export const substituteThisReceiver = (
	item: PendingAssignment,
	node: SyntaxNode,
): PendingAssignment => {
	if (item.kind !== "fieldAccess" && item.kind !== "methodCallResult")
		return item;
	if (!THIS_RECEIVERS.has(item.receiver)) return item;
	const className = findEnclosingClassName(node);
	if (!className) return item;
	return { ...item, receiver: className };
};

/** Find the enclosing function name for scope lookup.
 *  When an `enclosingFunctionFinder` hook is provided (from the language provider),
 *  it is consulted for each ancestor before the default FUNCTION_NODE_TYPES check.
 *  This handles languages like Dart where the function body is a sibling of the
 *  signature instead of a child. */
const findEnclosingScopeKey = (
	node: SyntaxNode,
	enclosingFunctionFinder?: (
		n: SyntaxNode,
	) => { funcName: string; label: NodeLabel } | null,
	extractFunctionNameHook?: (
		n: SyntaxNode,
	) => { funcName: string | null; label: NodeLabel } | null,
): string | undefined => {
	let current = node.parent;
	while (current) {
		if (FUNCTION_NODE_TYPES.has(current.type)) {
			const funcName =
				extractFunctionNameHook?.(current)?.funcName ?? genericFuncName(current);
			if (funcName) return `${funcName}@${current.startIndex}`;
		}
		// Language-specific hook (e.g., Dart function_body → sibling function_signature)
		if (enclosingFunctionFinder) {
			const result = enclosingFunctionFinder(current);
			if (result) {
				const sigNode = current.previousSibling;
				const startIdx = sigNode?.startIndex ?? current.startIndex;
				return `${result.funcName}@${startIdx}`;
			}
		}
		current = current.parent;
	}
	return undefined;
};

