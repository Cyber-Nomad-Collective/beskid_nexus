import { logger } from "../../logger.js";
import type { SemanticModel } from "../model/index.js";
import {
	extractReturnTypeName,
	extractSimpleTypeName,
} from "../type-extractors/shared.js";
import type {
	PendingAssignment,
	ReturnTypeLookup,
} from "../type-extractors/types.js";
import {
	CLASS_CONTAINER_TYPES,
	FUNCTION_NODE_TYPES,
	type SyntaxNode,
} from "../utils/ast-helpers.js";
import { CALL_EXPRESSION_TYPES } from "../utils/call-analysis.js";
import { FILE_SCOPE, type TypeEnv } from "./contracts.js";

const CLASS_LIKE_TYPES = new Set(["Class", "Struct", "Interface"]);
type ClassDefRef = { nodeId: string; type: string; filePath: string };

const lookupClassDefsByName = (
	model: SemanticModel,
	name: string,
	allowedTypes: ReadonlySet<string> = CLASS_LIKE_TYPES,
): ClassDefRef[] =>
	model.types.lookupClassByName(name).filter((d) => allowedTypes.has(d.type));

/** Memoize class definition lookups during fixpoint iteration.
 *  SymbolTable is immutable during type resolution, so results never change.
 *  Eliminates redundant array allocations + filter scans across iterations. */
const createClassDefCache = (model?: SemanticModel) => {
	const cache = new Map<string, ClassDefRef[]>();
	return (typeName: string) => {
		let result = cache.get(typeName);
		if (result === undefined) {
			result = model ? lookupClassDefsByName(model, typeName) : [];
			cache.set(typeName, result);
		}
		return result;
	};
};

/** AST node types representing constructor expressions across languages.
 *  Note: C# also has `implicit_object_creation_expression` (`new()` with type
 *  inference) which is NOT captured — the type is inferred, not explicit.
 *  Kotlin constructors use `call_expression` (no `new` keyword) — not detected. */
const CONSTRUCTOR_EXPR_TYPES = new Set([
	"new_expression", // TS/JS/C++: new Dog()
	"object_creation_expression", // Java/C#: new Dog()
]);

/** Extract the constructor class name from a declaration node's initializer.
 *  Searches for new_expression / object_creation_expression in the node's subtree.
 *  Returns the class name or undefined if no constructor is found.
 *  Depth-limited to 5 to avoid expensive traversals. */
export const extractConstructorTypeName = (
	node: SyntaxNode,
	depth = 0,
): string | undefined => {
	if (depth > 5) return undefined;
	if (CONSTRUCTOR_EXPR_TYPES.has(node.type)) {
		// Java/C#: object_creation_expression has 'type' field
		const typeField = node.childForFieldName("type");
		if (typeField) return extractSimpleTypeName(typeField);
		// TS/JS: new_expression has 'constructor' field (but tree-sitter often just has identifier child)
		const ctorField = node.childForFieldName("constructor");
		if (ctorField) return extractSimpleTypeName(ctorField);
		// Fallback: first named child is often the class identifier
		if (node.firstNamedChild) return extractSimpleTypeName(node.firstNamedChild);
	}
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (!child) continue;
		// Don't descend into nested functions/classes or call expressions (prevents
		// finding constructor args inside method calls, e.g. processAll(new Dog()))
		if (
			FUNCTION_NODE_TYPES.has(child.type) ||
			CLASS_CONTAINER_TYPES.has(child.type) ||
			CALL_EXPRESSION_TYPES.has(child.type)
		)
			continue;
		const result = extractConstructorTypeName(child, depth + 1);
		if (result) return result;
	}
	return undefined;
};

/** Max depth for MRO parent chain walking. Real-world inheritance rarely exceeds 3-4 levels. */
const MAX_MRO_DEPTH = 5;

/** Check if `child` is a subclass of `parent` using the parentMap.
 *  BFS up from child, depth-limited (5), cycle-safe. */
export const isSubclassOf = (
	child: string,
	parent: string,
	parentMap: ReadonlyMap<string, readonly string[]> | undefined,
): boolean => {
	if (!parentMap || child === parent) return false;
	const visited = new Set<string>([child]);
	let current = [child];
	for (let depth = 0; depth < MAX_MRO_DEPTH && current.length > 0; depth++) {
		const next: string[] = [];
		for (const cls of current) {
			const parents = parentMap.get(cls);
			if (!parents) continue;
			for (const p of parents) {
				if (p === parent) return true;
				if (!visited.has(p)) {
					visited.add(p);
					next.push(p);
				}
			}
		}
		current = next;
	}
	return false;
};

/** Walk up the parent class chain to find a field or method on an ancestor.
 *  BFS-like traversal with depth limit and cycle detection. First match wins.
 *  Used by resolveFieldType and resolveMethodReturnType when direct lookup fails. */
const walkParentChain = <T>(
	typeName: string,
	parentMap: ReadonlyMap<string, readonly string[]> | undefined,
	getClassDefs: (name: string) => ClassDefRef[],
	lookupOnClass: (nodeId: string) => T | undefined,
): T | undefined => {
	if (!parentMap) return undefined;
	const visited = new Set<string>([typeName]);
	let current = [typeName];
	for (let depth = 0; depth < MAX_MRO_DEPTH && current.length > 0; depth++) {
		const next: string[] = [];
		for (const cls of current) {
			const parents = parentMap.get(cls);
			if (!parents) continue;
			for (const parent of parents) {
				if (visited.has(parent)) continue;
				visited.add(parent);
				const parentDefs = getClassDefs(parent);
				if (parentDefs.length === 1) {
					const result = lookupOnClass(parentDefs[0].nodeId);
					if (result !== undefined) return result;
				}
				next.push(parent);
			}
		}
		current = next;
	}
	return undefined;
};

/** Resolve a field's declared type given a receiver variable and field name.
 *  Uses SymbolTable to find the class nodeId for the receiver's type, then
 *  looks up the field via the eagerly-populated fieldByOwner index.
 *  Falls back to MRO parent chain walking if direct lookup fails (Phase 11A). */
const resolveFieldType = (
	receiver: string,
	field: string,
	scopeEnv: ReadonlyMap<string, string>,
	model?: SemanticModel,
	getClassDefs?: (typeName: string) => ClassDefRef[],
	parentMap?: ReadonlyMap<string, readonly string[]>,
): string | undefined => {
	if (!model) return undefined;
	const receiverType = scopeEnv.get(receiver);
	if (!receiverType) return undefined;
	const lookup =
		getClassDefs ?? ((name: string) => lookupClassDefsByName(model, name));
	const classDefs = lookup(receiverType);
	if (classDefs.length !== 1) return undefined;
	// Direct lookup first
	const fieldDef = model.fields.lookupFieldByOwner(classDefs[0].nodeId, field);
	if (fieldDef?.declaredType)
		return extractReturnTypeName(fieldDef.declaredType);
	// MRO parent chain walking on miss
	const inherited = walkParentChain(
		receiverType,
		parentMap,
		lookup,
		(nodeId) => {
			const f = model.fields.lookupFieldByOwner(nodeId, field);
			return f?.declaredType ? extractReturnTypeName(f.declaredType) : undefined;
		},
	);
	return inherited;
};

/** Resolve a method's return type given a receiver variable and method name.
 *  Uses SymbolTable to find class nodeIds for the receiver's type, then
 *  looks up the method via owner-scoped lookupMethodByOwner.
 *  Falls back to MRO parent chain walking if direct lookup fails (Phase 11A). */
const resolveMethodReturnType = (
	receiver: string,
	method: string,
	scopeEnv: ReadonlyMap<string, string>,
	model?: SemanticModel,
	getClassDefs?: (typeName: string) => ClassDefRef[],
	parentMap?: ReadonlyMap<string, readonly string[]>,
): string | undefined => {
	if (!model) return undefined;
	let receiverType = scopeEnv.get(receiver);
	// When substituteThisReceiver replaced $this/self with the enclosing class name,
	// the receiver IS the type — look it up directly as a class name.
	if (!receiverType) {
		const lookup =
			getClassDefs ?? ((name: string) => lookupClassDefsByName(model, name));
		if (lookup(receiver).length > 0) receiverType = receiver;
	}
	if (!receiverType) return undefined;
	const lookup =
		getClassDefs ?? ((name: string) => lookupClassDefsByName(model, name));
	const classDefs = lookup(receiverType);
	if (classDefs.length === 0) return undefined;
	// Direct lookup first
	const directMethodLookups = classDefs.map((d) => ({
		classDef: d,
		methodDef: model.methods.lookupMethodByOwner(d.nodeId, method),
	}));
	const hasAmbiguousDirectLookup = directMethodLookups.some(
		({ classDef, methodDef }) => {
			if (methodDef) return false;
			return model.symbols
				.lookupExactAll(classDef.filePath, method)
				.some((d) => d.ownerId === classDef.nodeId);
		},
	);
	if (hasAmbiguousDirectLookup) return undefined;
	const methods = directMethodLookups
		.map(({ methodDef }) => methodDef)
		.filter((d): d is NonNullable<typeof d> => d !== undefined);
	if (methods.length === 1 && methods[0].returnType) {
		return extractReturnTypeName(methods[0].returnType);
	}
	// MRO parent chain walking on miss
	if (methods.length === 0) {
		const inherited = walkParentChain(
			receiverType,
			parentMap,
			lookup,
			(nodeId) => {
				const parentMethod = model.methods.lookupMethodByOwner(nodeId, method);
				if (!parentMethod?.returnType) return undefined;
				return extractReturnTypeName(parentMethod.returnType);
			},
		);
		return inherited;
	}
	return undefined;
};

/**
 * Unified fixpoint propagation: iterate over ALL pending items (copy, callResult,
 * fieldAccess, methodCallResult) until no new bindings are produced.
 * Handles arbitrary-depth mixed chains:
 *   const user = getUser();      // callResult → User
 *   const addr = user.address;   // fieldAccess → Address (depends on user)
 *   const city = addr.getCity(); // methodCallResult → City (depends on addr)
 *   const alias = city;          // copy → City (depends on city)
 * Data flow: SymbolTable (immutable) + scopeEnv → resolve → scopeEnv.
 * Termination: finite entries, each bound at most once (first-writer-wins), max 10 iterations.
 */
const MAX_FIXPOINT_ITERATIONS = 10;

export const resolveFixpointBindings = (
	pendingItems: Array<{ scope: string } & PendingAssignment>,
	env: TypeEnv,
	returnTypeLookup: ReturnTypeLookup,
	model?: SemanticModel,
	parentMap?: ReadonlyMap<string, readonly string[]>,
): void => {
	if (pendingItems.length === 0) return;
	const getClassDefs = createClassDefCache(model);
	const resolved = new Set<number>();
	for (let iter = 0; iter < MAX_FIXPOINT_ITERATIONS; iter++) {
		let changed = false;
		for (let i = 0; i < pendingItems.length; i++) {
			if (resolved.has(i)) continue;
			const item = pendingItems[i];
			const scopeEnv = env.get(item.scope);
			if (!scopeEnv || scopeEnv.has(item.lhs)) {
				resolved.add(i);
				continue;
			}

			let typeName: string | undefined;
			switch (item.kind) {
				case "callResult":
					// Phase 9: Prefer FQN lookup when available for higher precision
					typeName = item.calleeFqn
						? returnTypeLookup.lookupReturnType(item.calleeFqn)
						: returnTypeLookup.lookupReturnType(item.callee);
					break;
				case "copy":
					typeName = scopeEnv.get(item.rhs) ?? env.get(FILE_SCOPE)?.get(item.rhs);
					break;
				case "fieldAccess":
					typeName = resolveFieldType(
						item.receiver,
						item.field,
						scopeEnv,
						model,
						getClassDefs,
						parentMap,
					);
					break;
				case "methodCallResult":
					typeName = resolveMethodReturnType(
						item.receiver,
						item.method,
						scopeEnv,
						model,
						getClassDefs,
						parentMap,
					);
					break;
				default: {
					// Exhaustive check: TypeScript will error here if a new PendingAssignment
					// kind is added without handling it in the switch.
					const _exhaustive: never = item;
					break;
				}
			}
			if (typeName) {
				scopeEnv.set(item.lhs, typeName);
				resolved.add(i);
				changed = true;
			}
		}
		if (!changed) break;
		if (iter === MAX_FIXPOINT_ITERATIONS - 1 && process.env.GITNEXUS_DEBUG) {
			const unresolved = pendingItems.length - resolved.size;
			if (unresolved > 0) {
				logger.warn(
					`[type-env] fixpoint hit iteration cap (${MAX_FIXPOINT_ITERATIONS}), ${unresolved} items unresolved`,
				);
			}
		}
	}
};

