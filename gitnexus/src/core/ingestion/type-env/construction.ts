import type { SupportedLanguages } from "gitnexus-shared";
import type {
	BindingAccumulator,
	BindingEntry,
} from "../binding-accumulator.js";
import { getProvider } from "../languages/index.js";
import type { SemanticModel } from "../model/index.js";
import {
	extractReturnTypeName,
	extractVarName,
	TYPED_PARAMETER_TYPES,
} from "../type-extractors/shared.js";
import type {
	ForLoopExtractorContext,
	PendingAssignment,
	ReturnTypeLookup,
} from "../type-extractors/types.js";
import {
	CLASS_CONTAINER_TYPES,
	FUNCTION_NODE_TYPES,
	genericFuncName,
	type SyntaxNode,
} from "../utils/ast-helpers.js";
import {
	createClassNameLookup,
	enclosingClassNameCache,
	enclosingParentClassNameCache,
} from "./caches.js";
import {
	type BuildTypeEnvOptions,
	type ConstructorBinding,
	FILE_SCOPE,
	emptyFileScope,
	type PatternOverrides,
	type TypeEnv,
	type TypeEnvironment,
} from "./contracts.js";
import {
	extractConstructorTypeName,
	resolveFixpointBindings,
} from "./generics-inheritance.js";
import {
	findNarrowingBranchScope,
	findTypeIdentifierChild,
} from "./language-normalization.js";
import {
	lookupInEnv,
	substituteThisReceiver,
} from "./lookup-resolution.js";

/**
 * Build a TypeEnvironment from a tree-sitter AST for a given language.
 * Single-pass: collects class/struct names, type bindings, AND constructor
 * bindings that couldn't be resolved locally — all in one AST walk.
 *
 * When a symbolTable is provided (call-processor path), class names from across
 * the project are available for constructor inference in languages like Kotlin
 * where constructors are syntactically identical to function calls.
 */
/**
 * Node types whose subtrees can NEVER contain type-relevant descendants
 * (declarations, parameters, for-loops, class definitions, pattern bindings).
 * Conservative leaf-only set — verified safe across all 12 supported language grammars.
 * IMPORTANT: Do NOT add expression containers (arguments, binary_expression, etc.) —
 * they can contain arrow functions with typed parameters.
 */
const SKIP_SUBTREE_TYPES = new Set([
	// Plain string literals (NOT template_string — it contains interpolated expressions
	// that can hold arrow functions with typed parameters, e.g. `${(x: T) => x}`)
	"string",
	"string_literal",
	"string_content",
	"string_fragment",
	"heredoc_body",
	// Comments
	"comment",
	"line_comment",
	"block_comment",
	// Numeric/boolean/null literals
	"number",
	"integer_literal",
	"float_literal",
	"true",
	"false",
	"null",
	// Regex
	"regex",
	"regex_pattern",
]);

/** Seed cross-file type bindings into the file scope.
 *  MUST be called AFTER walk() completes so that local declarations
 *  (Tier 0/1) always take precedence over imported bindings (first-writer-wins). */
function seedImportedBindings(
	env: TypeEnv,
	importedBindings: ReadonlyMap<string, string>,
): void {
	let fileEnv = env.get(FILE_SCOPE);
	if (!fileEnv) {
		fileEnv = new Map();
		env.set(FILE_SCOPE, fileEnv);
	}
	for (const [name, type] of importedBindings) {
		if (!fileEnv.has(name)) {
			fileEnv.set(name, type);
		}
	}
}

export const buildTypeEnv = (
	tree: { rootNode: SyntaxNode },
	language: SupportedLanguages,
	options?: BuildTypeEnvOptions,
): TypeEnvironment => {
	// Clear per-file memoization caches from the previous file.
	enclosingClassNameCache.clear();
	enclosingParentClassNameCache.clear();

	const model = options?.model;
	const parentMap = options?.parentMap;
	const extractFuncNameHook = options?.extractFunctionName;
	const env: TypeEnv = new Map();
	let flushed = false;
	const patternOverrides: PatternOverrides = new Map();
	// Phase P: maps `scope\0varName` → constructor type when a declaration has BOTH
	// a base type annotation AND a more specific constructor initializer.
	// e.g., `Animal a = new Dog()` → constructorTypeMap.set('func@42\0a', 'Dog')
	const constructorTypeMap = new Map<string, string>();
	const localClassNames = new Set<string>();
	const classNames = createClassNameLookup(localClassNames, model);
	const provider = getProvider(language);
	const config = provider.typeConfig;
	const bindings: ConstructorBinding[] = [];

	// Build ReturnTypeLookup: SymbolTable is authoritative when it has an unambiguous match.
	// Cross-file importedReturnTypes are consulted ONLY when SymbolTable has 0 matches.
	// Ambiguous (2+) → undefined, no cross-file fallback (conservative, local-first principle).
	// Post-A4 Unit 4: callableByName no longer holds Method/Constructor, so
	// for-loop binding inference must also consult methodsByName to find
	// return types on class methods (e.g. `user.getItems()` iteration).
	// Take `model` as an explicit argument so the non-null precondition
	// is visible at the type level. Callers must enter these via an
	// `if (model)` guard on their side and pass the narrowed reference.
	const getCallableUnionCount = (m: SemanticModel, callee: string): number => {
		return (
			m.symbols.lookupCallableByName(callee).length +
			m.methods.lookupMethodByName(callee).length
		);
	};
	const getFirstCallable = (m: SemanticModel, callee: string) => {
		const free = m.symbols.lookupCallableByName(callee);
		if (free.length > 0) return free[0];
		const methods = m.methods.lookupMethodByName(callee);
		return methods.length > 0 ? methods[0] : undefined;
	};

	const returnTypeLookup: ReturnTypeLookup = {
		lookupReturnType(callee: string): string | undefined {
			// SymbolTable is authoritative when it has an unambiguous match
			if (model) {
				if (provider.isBuiltInName(callee)) return undefined;
				const count = getCallableUnionCount(model, callee);
				if (count === 1) {
					const rawReturn = getFirstCallable(model, callee)?.returnType;
					if (rawReturn) return extractReturnTypeName(rawReturn);
				}
				// Ambiguous (2+) → return undefined (conservative, no cross-file fallback)
				if (count > 1) return undefined;
			}
			// No match (0 results or no symbolTable) → fall back to cross-file
			return options?.importedReturnTypes?.get(callee);
		},
		lookupRawReturnType(callee: string): string | undefined {
			if (model) {
				if (provider.isBuiltInName(callee)) return undefined;
				const count = getCallableUnionCount(model, callee);
				if (count === 1) return getFirstCallable(model, callee)?.returnType;
				// Ambiguous (2+) → return undefined (conservative, no cross-file fallback)
				if (count > 1) return undefined;
			}
			// Cross-file fallback uses importedRawReturnTypes (raw declared types, e.g., 'User[]')
			// NOT importedReturnTypes (which contains processed/simple types via extractReturnTypeName)
			return options?.importedRawReturnTypes?.get(callee);
		},
	};

	// Pre-compute combined set of node types that need extractTypeBinding.
	// Single Set.has() replaces 3 separate checks per node in walk().
	const interestingNodeTypes = new Set<string>();
	TYPED_PARAMETER_TYPES.forEach((t) => interestingNodeTypes.add(t));
	config.declarationNodeTypes.forEach((t) => interestingNodeTypes.add(t));
	config.forLoopNodeTypes?.forEach((t) => interestingNodeTypes.add(t));
	// Tier 2: unified fixpoint propagation — collects copy, callResult, fieldAccess, and
	// methodCallResult items during walk(), then iterates until no new bindings are produced.
	// Handles arbitrary-depth mixed chains: callResult → fieldAccess → methodCallResult → copy.
	const pendingItems: Array<{ scope: string } & PendingAssignment> = [];
	// For-loop nodes whose iterable was unresolved at walk-time. Replayed after the fixpoint
	// resolves the iterable's type, bridging the walk-time/fixpoint gap (Phase 10 / ex-9B).
	const pendingForLoops: Array<{ node: SyntaxNode; scope: string }> = [];
	// Maps `scope\0varName` → the type annotation AST node from the original declaration.
	// Allows pattern extractors to navigate back to the declaration's generic type arguments
	// (e.g., to extract T from Result<T, E> for `if let Ok(x) = res`).
	// NOTE: This is a SUPERSET of scopeEnv — entries exist even when extractSimpleTypeName
	// returns undefined for container types (User[], []User, List[User]). This is intentional:
	// for-loop Strategy 1 needs the raw AST type node for exactly those container types.
	const declarationTypeNodes = new Map<string, SyntaxNode>();

	/**
	 * Try to extract a (variableName → typeName) binding from a single AST node.
	 *
	 * Resolution tiers (first match wins):
	 * - Tier 0: explicit type annotations via extractDeclaration / extractForLoopBinding
	 * - Tier 1: constructor-call inference via extractInitializer (fallback)
	 *
	 * Side effect: populates declarationTypeNodes for variables that have an explicit
	 * type annotation field on the declaration node. This allows pattern extractors to
	 * retrieve generic type arguments from the original declaration (e.g., extracting T
	 * from Result<T, E> for `if let Ok(x) = res`).
	 */
	const extractTypeBinding = (
		node: SyntaxNode,
		scopeEnv: Map<string, string>,
		scope: string,
	): void => {
		// This guard eliminates 90%+ of calls before any language dispatch.
		if (TYPED_PARAMETER_TYPES.has(node.type)) {
			// Capture the raw type annotation BEFORE extractParameter.
			// Most languages use 'name' field; Rust uses 'pattern'; TS uses 'pattern' for some param types.
			// Kotlin `parameter` nodes use positional children instead of named fields,
			// so we fall back to scanning children by type when childForFieldName returns null.
			const typeNode = node.childForFieldName("type");
			if (typeNode) {
				const nameNode =
					node.childForFieldName("name") ??
					node.childForFieldName("pattern") ??
					// Python typed_parameter: name is a positional child (identifier), not a named field
					(node.firstNamedChild?.type === "identifier"
						? node.firstNamedChild
						: null);
				if (nameNode) {
					const varName = extractVarName(nameNode);
					if (varName && !declarationTypeNodes.has(`${scope}\0${varName}`)) {
						declarationTypeNodes.set(`${scope}\0${varName}`, typeNode);
					}
				}
			} else {
				// Fallback: positional children (Kotlin `parameter` → simple_identifier + user_type)
				let fallbackName: SyntaxNode | null = null;
				let fallbackType: SyntaxNode | null = null;
				for (let i = 0; i < node.namedChildCount; i++) {
					const child = node.namedChild(i);
					if (!child) continue;
					if (
						!fallbackName &&
						(child.type === "simple_identifier" || child.type === "identifier")
					) {
						fallbackName = child;
					}
					if (
						!fallbackType &&
						(child.type === "user_type" ||
							child.type === "type_identifier" ||
							child.type === "generic_type" ||
							child.type === "parameterized_type" ||
							child.type === "nullable_type")
					) {
						fallbackType = child;
					}
				}
				if (fallbackName && fallbackType) {
					const varName = extractVarName(fallbackName);
					if (varName && !declarationTypeNodes.has(`${scope}\0${varName}`)) {
						declarationTypeNodes.set(`${scope}\0${varName}`, fallbackType);
					}
				}
			}
			config.extractParameter(node, scopeEnv);
			return;
		}
		// For-each loop variable bindings (Java/C#/Kotlin): explicit element types in the AST.
		// Checked before declarationNodeTypes — loop variables are not declarations.
		if (config.forLoopNodeTypes?.has(node.type)) {
			if (config.extractForLoopBinding) {
				const sizeBefore = scopeEnv.size;
				const forLoopCtx: ForLoopExtractorContext = {
					scopeEnv,
					declarationTypeNodes,
					scope,
					returnTypeLookup,
				};
				config.extractForLoopBinding(node, forLoopCtx);
				// If no new binding was produced, the iterable's type may not yet be resolved.
				// Store for post-fixpoint replay (Phase 10 / ex-9B loop-fixpoint bridge).
				if (scopeEnv.size === sizeBefore) {
					pendingForLoops.push({ node, scope });
				}
			}
			return;
		}
		if (config.declarationNodeTypes.has(node.type)) {
			// Capture the raw type annotation AST node BEFORE extractDeclaration.
			// This decouples type node capture from scopeEnv success — container types
			// (User[], []User, List[User]) that fail extractSimpleTypeName still get
			// their AST type node recorded for Strategy 1 for-loop resolution.
			//
			// Prefer language-specific locator when provided (keeps buildTypeEnv generic),
			// then fall back to a small set of safe, cross-grammar heuristics.
			let typeNode =
				config.getDeclarationTypeNode?.(node) ??
				node.childForFieldName("type") ??
				null;
			// Fallback: some grammars wrap type annotations in a `type_annotation` child
			// instead of exposing a named `type` field on the declaration node.
			if (!typeNode) {
				for (let i = 0; i < node.namedChildCount; i++) {
					const c = node.namedChild(i);
					if (c?.type === "type_annotation") {
						typeNode = c.firstNamedChild ?? c;
						break;
					}
				}
			}
			if (typeNode) {
				const nameNode =
					node.childForFieldName("name") ??
					node.childForFieldName("left") ??
					node.childForFieldName("pattern");
				if (nameNode) {
					const varName = extractVarName(nameNode);
					if (varName && !declarationTypeNodes.has(`${scope}\0${varName}`)) {
						declarationTypeNodes.set(`${scope}\0${varName}`, typeNode);
					}
				}
			}
			// Run the language-specific declaration extractor (may or may not add to scopeEnv).
			const sizeBefore = typeNode ? scopeEnv.size : -1;
			config.extractDeclaration(node, scopeEnv);
			// Fallback: for multi-declarator languages (TS, C#, Java) where the type field
			// is on variable_declarator children, capture newly-added keys.
			// Map preserves insertion order, so new keys are always at the end —
			// skip the first sizeBefore entries to find only newly-added variables.
			if (sizeBefore >= 0 && scopeEnv.size > sizeBefore) {
				let skip = sizeBefore;
				for (const varName of scopeEnv.keys()) {
					if (skip > 0) {
						skip--;
						continue;
					}
					if (!declarationTypeNodes.has(`${scope}\0${varName}`)) {
						declarationTypeNodes.set(`${scope}\0${varName}`, typeNode);
					}
				}
			}
			// Tier 1: constructor-call inference as fallback.
			// Always called when available — each language's extractInitializer
			// internally skips declarators that already have explicit annotations,
			// so this handles mixed cases like `const a: A = x, b = new B()`.
			if (config.extractInitializer) {
				config.extractInitializer(node, scopeEnv, classNames);
			}

			// Phase P: detect constructor-visible virtual dispatch.
			// When a declaration has BOTH a type annotation AND a constructor initializer,
			// record the constructor type for receiver override at call resolution time.
			// e.g., `Animal a = new Dog()` → constructorTypeMap.set('scope\0a', 'Dog')
			if (sizeBefore >= 0 && scopeEnv.size > sizeBefore) {
				let ctorSkip = sizeBefore;
				for (const varName of scopeEnv.keys()) {
					if (ctorSkip > 0) {
						ctorSkip--;
						continue;
					}
					const declaredType = scopeEnv.get(varName);
					if (!declaredType) continue;
					const ctorType =
						extractConstructorTypeName(node) ??
						config.detectConstructorType?.(node, classNames);
					if (!ctorType || ctorType === declaredType) continue;
					// Unwrap wrapper types (e.g., C++ shared_ptr<Animal> → Animal) for an
					// accurate isSubclassOf comparison. Language-specific via config hook.
					const declTypeNode = declarationTypeNodes.get(`${scope}\0${varName}`);
					const effectiveDeclaredType =
						declTypeNode && config.unwrapDeclaredType
							? (config.unwrapDeclaredType(declaredType, declTypeNode) ?? declaredType)
							: declaredType;
					if (ctorType !== effectiveDeclaredType) {
						constructorTypeMap.set(`${scope}\0${varName}`, ctorType);
					}
				}
			}
		}
	};

	const stack: Array<{ node: SyntaxNode; scope: string }> = [
		{ node: tree.rootNode, scope: FILE_SCOPE },
	];

	const processNode = (node: SyntaxNode, currentScope: string): void => {
		// Fast skip: subtrees that can never contain type-relevant nodes (leaf-like literals).
		if (SKIP_SUBTREE_TYPES.has(node.type)) return;

		// Collect class/struct names as we encounter them (used by extractInitializer
		// to distinguish constructor calls from function calls, e.g. C++ `User()` vs `getUser()`)
		// Currently only C++ uses this locally; other languages rely on the SymbolTable path.
		if (CLASS_CONTAINER_TYPES.has(node.type)) {
			// Most languages use 'name' field; Kotlin uses a type_identifier child instead
			const nameNode =
				node.childForFieldName("name") ?? findTypeIdentifierChild(node);
			if (nameNode) localClassNames.add(nameNode.text);
		}

		// Detect scope boundaries (function/method definitions)
		let scope = currentScope;
		if (FUNCTION_NODE_TYPES.has(node.type)) {
			const funcName =
				extractFuncNameHook?.(node)?.funcName ?? genericFuncName(node);
			if (funcName) scope = `${funcName}@${node.startIndex}`;
		}

		// Only create scope map and call extractTypeBinding for interesting node types.
		// Single Set.has() replaces 3 separate checks inside extractTypeBinding.
		if (interestingNodeTypes.has(node.type)) {
			if (!env.has(scope)) env.set(scope, new Map());
			const scopeEnv = env.get(scope)!;
			extractTypeBinding(node, scopeEnv, scope);
		}

		// Pattern binding extraction: handles constructs that introduce NEW typed variables
		// via pattern matching (e.g. `if let Some(x) = opt`, `x instanceof T t`)
		// or narrow existing variables within a branch (null-check narrowing).
		// Runs after Tier 0/1 so scopeEnv already contains the source variable's type.
		// Conservative: extractor returns undefined when source type is unknown.
		if (
			config.extractPatternBinding &&
			(!config.patternBindingNodeTypes ||
				config.patternBindingNodeTypes.has(node.type))
		) {
			// Ensure scopeEnv exists for pattern binding reads/writes
			if (!env.has(scope)) env.set(scope, new Map());
			const scopeEnv = env.get(scope)!;
			const patternBinding = config.extractPatternBinding(
				node,
				scopeEnv,
				declarationTypeNodes,
				scope,
			);
			if (patternBinding) {
				if (patternBinding.narrowingRange) {
					// Explicit narrowing range (null-check narrowing): always store in patternOverrides
					// using the extractor-provided range (typically the if-body block).
					if (!patternOverrides.has(scope)) patternOverrides.set(scope, new Map());
					const varMap = patternOverrides.get(scope)!;
					if (!varMap.has(patternBinding.varName))
						varMap.set(patternBinding.varName, []);
					varMap.get(patternBinding.varName)?.push({
						rangeStart: patternBinding.narrowingRange.startIndex,
						rangeEnd: patternBinding.narrowingRange.endIndex,
						typeName: patternBinding.typeName,
					});
				} else if (config.allowPatternBindingOverwrite) {
					// Position-indexed: store per-branch binding for smart-cast narrowing.
					// Each when arm / switch case gets its own type for the variable,
					// preventing cross-arm contamination (e.g., Kotlin when/is).
					const branchNode = findNarrowingBranchScope(node);
					if (branchNode) {
						if (!patternOverrides.has(scope)) patternOverrides.set(scope, new Map());
						const varMap = patternOverrides.get(scope)!;
						if (!varMap.has(patternBinding.varName))
							varMap.set(patternBinding.varName, []);
						varMap.get(patternBinding.varName)?.push({
							rangeStart: branchNode.startIndex,
							rangeEnd: branchNode.endIndex,
							typeName: patternBinding.typeName,
						});
					}
					// Also store in flat scopeEnv as fallback (last arm wins — same as before
					// for code that doesn't use position-indexed lookup).
					scopeEnv.set(patternBinding.varName, patternBinding.typeName);
				} else if (!scopeEnv.has(patternBinding.varName)) {
					// First-writer-wins for languages without smart-cast overwrite (Java instanceof, etc.)
					scopeEnv.set(patternBinding.varName, patternBinding.typeName);
				}
			}
		}

		// Tier 2: collect plain-identifier RHS assignments for post-walk propagation.
		// Delegates to per-language extractPendingAssignment — AST shapes differ widely
		// (JS uses variable_declarator/name/value, Rust uses let_declaration/pattern/value,
		// Python uses assignment/left/right, Go uses short_var_declaration/expression_list).
		// May return a single item or an array (for destructuring: N fieldAccess items).
		if (
			config.extractPendingAssignment &&
			config.declarationNodeTypes.has(node.type)
		) {
			// scopeEnv is guaranteed to exist here because declarationNodeTypes is a subset
			// of interestingNodeTypes, so extractTypeBinding already created the scope map above.
			const scopeEnv = env.get(scope);
			if (scopeEnv) {
				const pending = config.extractPendingAssignment(node, scopeEnv);
				if (pending) {
					const items = Array.isArray(pending) ? pending : [pending];
					for (const item of items) {
						// Substitute this/self/$this/Me receivers with enclosing class name
						const resolved = substituteThisReceiver(item, node);
						pendingItems.push({ scope, ...resolved });
					}
				}
			}
		}

		// Scan for constructor bindings that couldn't be resolved locally.
		// Only collect if TypeEnv didn't already resolve this binding.
		if (config.scanConstructorBinding) {
			const result = config.scanConstructorBinding(node);
			if (result) {
				const scopeEnv = env.get(scope);
				if (!scopeEnv?.has(result.varName)) {
					bindings.push({ scope, ...result });
				}
			}
		}

		// Push children onto stack (reverse order so first child is processed first)
		for (let i = node.childCount - 1; i >= 0; i--) {
			const child = node.child(i);
			if (child) stack.push({ node: child, scope });
		}
	};

	// Iterative traversal using explicit stack instead of recursion
	// to avoid "Maximum call stack size exceeded" on large files (2000+ lines)
	while (stack.length > 0) {
		const { node, scope } = stack.pop()!;
		processNode(node, scope);
	}

	// Phase 14: Seed cross-file bindings from upstream files AFTER walk
	// (local declarations from walk() take precedence — first-writer-wins)
	if (options?.importedBindings && options.importedBindings.size > 0) {
		seedImportedBindings(env, options.importedBindings);
	}

	resolveFixpointBindings(pendingItems, env, returnTypeLookup, model, parentMap);

	// Post-fixpoint for-loop replay (Phase 10 / ex-9B loop-fixpoint bridge):
	// For-loop nodes whose iterables were unresolved at walk-time may now be
	// resolvable because the fixpoint bound the iterable's type.
	// Example: `const users = getUsers(); for (const u of users) { u.save(); }`
	//   - walk-time: users untyped → u unresolved
	//   - fixpoint: users → User[]
	//   - replay: users now typed → u → User
	if (pendingForLoops.length > 0 && config.extractForLoopBinding) {
		for (const { node, scope } of pendingForLoops) {
			if (!env.has(scope)) env.set(scope, new Map());
			const scopeEnv = env.get(scope)!;
			config.extractForLoopBinding(node, {
				scopeEnv,
				declarationTypeNodes,
				scope,
				returnTypeLookup,
			});
		}
		// Re-run the main fixpoint to resolve items that depended on loop variables.
		// Only needed if replay actually produced new bindings.
		const unresolvedBefore = pendingItems.filter((item) => {
			const scopeEnv = env.get(item.scope);
			return scopeEnv && !scopeEnv.has(item.lhs);
		});
		if (unresolvedBefore.length > 0) {
			resolveFixpointBindings(unresolvedBefore, env, returnTypeLookup, model);
		}
	}

	return {
		lookup: (varName, callNode) =>
			lookupInEnv(
				env,
				varName,
				callNode,
				patternOverrides,
				options?.enclosingFunctionFinder,
				extractFuncNameHook,
			),
		constructorBindings: bindings,
		fileScope: () => env.get(FILE_SCOPE) ?? emptyFileScope(),
		allScopes: () => env as ReadonlyMap<string, ReadonlyMap<string, string>>,
		constructorTypeMap,
		flush(filePath: string, accumulator: BindingAccumulator): void {
			if (flushed) {
				throw new Error(
					`[TypeEnvironment] flush called twice for ${filePath} — flush is single-use`,
				);
			}
			// Narrow flush() to iterate only the FILE_SCOPE entry, mirroring the
			// worker-path narrowing in parse-worker.ts (commit 803631fe). Before
			// this change, both execution paths had the same asymmetry bug: the
			// worker path was fixed but the sequential path (this code) still
			// wrote function-scope entries into long-lived accumulator storage
			// that no consumer reads until Phase 9 lands.
			//
			// Phase 9 reversion: when a downstream consumer of function-scope
			// bindings exists, restore the nested iteration:
			//
			//   for (const [scope, scopeMap] of env) {
			//     for (const [varName, typeName] of scopeMap) {
			//       entries.push({ scope, varName, typeName });
			//     }
			//   }
			//
			// See BindingAccumulator class JSDoc and FileScopeBindings JSDoc in
			// parse-worker.ts for the full reversion checklist.
			const fileScope = env.get(FILE_SCOPE) ?? emptyFileScope();
			const entries: BindingEntry[] = [];
			for (const [varName, typeName] of fileScope) {
				entries.push({ scope: "", varName, typeName });
			}
			if (entries.length > 0) {
				accumulator.appendFile(filePath, entries);
			}
			// Mark the env as flushed AFTER the successful append. If appendFile
			// throws (e.g., accumulator is already finalized due to a lifecycle
			// ordering bug), the caller can catch and retry — the single-use
			// guard now tracks "data was written", not "flush was attempted".
			flushed = true;
		},
	};
};
