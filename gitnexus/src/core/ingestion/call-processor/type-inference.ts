import {
	FUNCTION_NODE_TYPES,
	MAX_EXPORTS_PER_FILE,
	MAX_TYPE_NAME_LENGTH,
	buildCollisionGroups,
	constTagForId,
	extractReturnTypeName,
	findEnclosingClassInfo,
	generateId,
	genericFuncName,
	getLanguageFromFilename,
	inferFunctionLabel,
	receiverKey,
	typeTagForId,
} from "./context.js";
import type {
	BindingAccumulator,
	ConstructorBinding,
	ExportedTypeMap,
	ExtractedCall,
	HeritageMap,
	KnowledgeGraph,
	MethodInfo,
	ResolutionContext,
	SymbolTableReader,
	SyntaxNode,
} from "./context.js";

/** Build a map of imported callee names → return types for cross-file call-result binding.
 *  Consulted ONLY when SymbolTable has no unambiguous local match (local-first principle).
 *
 *  Overlapping mechanism (1 of 3): this is the SymbolTable-backed path.
 *  See also:
 *    2. collectExportedBindings (~line 168) / enrichExportedTypeMap — TypeEnv + graph isExported
 *    3. Phase 9 fallback in verifyConstructorBindings (~line 563) — namedImportMap + BindingAccumulator
 *  A future cleanup should merge these into a single resolution pass. */
export function buildImportedReturnTypes(
	filePath: string,
	namedImportMap: ReadonlyMap<
		string,
		ReadonlyMap<string, { sourcePath: string; exportedName: string }>
	>,
	symbolTable: {
		lookupExactFull(
			filePath: string,
			name: string,
		): { returnType?: string } | undefined;
	},
): ReadonlyMap<string, string> {
	const result = new Map<string, string>();
	const fileImports = namedImportMap.get(filePath);
	if (!fileImports) return result;

	for (const [localName, binding] of fileImports) {
		const def = symbolTable.lookupExactFull(
			binding.sourcePath,
			binding.exportedName,
		);
		if (!def?.returnType) continue;
		const simpleReturn = extractReturnTypeName(def.returnType);
		if (simpleReturn) result.set(localName, simpleReturn);
	}
	return result;
}

/** Build cross-file RAW return types for imported callables.
 *  Unlike buildImportedReturnTypes (which stores extractReturnTypeName output),
 *  this stores the raw declared return type string (e.g., 'User[]', 'List<User>').
 *  Used by lookupRawReturnType for for-loop element extraction via extractElementTypeFromString. */
export function buildImportedRawReturnTypes(
	filePath: string,
	namedImportMap: ReadonlyMap<
		string,
		ReadonlyMap<string, { sourcePath: string; exportedName: string }>
	>,
	symbolTable: {
		lookupExactFull(
			filePath: string,
			name: string,
		): { returnType?: string } | undefined;
	},
): ReadonlyMap<string, string> {
	const result = new Map<string, string>();
	const fileImports = namedImportMap.get(filePath);
	if (!fileImports) return result;

	for (const [localName, binding] of fileImports) {
		const def = symbolTable.lookupExactFull(
			binding.sourcePath,
			binding.exportedName,
		);
		if (!def?.returnType) continue;
		result.set(localName, def.returnType);
	}
	return result;
}

/** Collect resolved type bindings for exported file-scope symbols.
 *  Uses graph node isExported flag — does NOT require isExported on SymbolDefinition.
 *
 *  **Counterpart**: the worker path populates `exportedTypeMap` via the
 *  accumulator enrichment loop in `pipeline.ts` (search for "Worker path
 *  quality enrichment"). Both sites populate the same map with subtly
 *  different export-check semantics — this site uses SymbolTable +
 *  graph lookup, the worker loop uses three-candidate-ID graph lookup.
 *  They must stay in sync until unified. If you edit one, check the other.
 *
 *  Overlapping mechanism (2 of 3): this is the TypeEnv + graph isExported path.
 *  See also:
 *    1. buildImportedReturnTypes (~line 109) — namedImportMap + SymbolTable
 *    3. Phase 9 fallback in verifyConstructorBindings (~line 563) — namedImportMap + BindingAccumulator
 *  A future cleanup should merge these into a single resolution pass. */
export function collectExportedBindings(
	typeEnv: { fileScope(): ReadonlyMap<string, string> },
	filePath: string,
	symbolTable: {
		lookupExact(filePath: string, name: string): string | undefined;
	},
	graph: {
		getNode(id: string): { properties?: { isExported?: boolean } } | undefined;
	},
): Map<string, string> | null {
	const fileScope = typeEnv.fileScope();
	if (!fileScope || fileScope.size === 0) return null;

	const exported = new Map<string, string>();
	for (const [varName, typeName] of fileScope) {
		if (exported.size >= MAX_EXPORTS_PER_FILE) break;
		if (!typeName || typeName.length > MAX_TYPE_NAME_LENGTH) continue;
		const nodeId = symbolTable.lookupExact(filePath, varName);
		if (!nodeId) continue;
		const node = graph.getNode(nodeId);
		if (node?.properties?.isExported) {
			exported.set(varName, typeName);
		}
	}
	return exported.size > 0 ? exported : null;
}

/** Build ExportedTypeMap from graph nodes — used for worker path where TypeEnv
 *  is not available in the main thread. Collects returnType/declaredType from
 *  exported symbols that have callables with known return types. */
export function buildExportedTypeMapFromGraph(
	graph: KnowledgeGraph,
	symbolTable: SymbolTableReader,
): ExportedTypeMap {
	const result: ExportedTypeMap = new Map();
	graph.forEachNode((node) => {
		if (!node.properties?.isExported) return;
		if (!node.properties?.filePath || !node.properties?.name) return;
		const filePath = node.properties.filePath as string;
		const name = node.properties.name as string;
		if (!name || name.length > MAX_TYPE_NAME_LENGTH) return;
		// For callable symbols, use returnType; for properties/variables, use declaredType.
		// Use lookupExactAll + nodeId match to handle same-name methods in different classes.
		const defs = symbolTable.lookupExactAll(filePath, name);
		const def = defs.find((d) => d.nodeId === node.id) ?? defs[0];
		if (!def) return;
		const typeName = def.returnType ?? def.declaredType;
		if (!typeName || typeName.length > MAX_TYPE_NAME_LENGTH) return;
		// Extract simple type name (strip Promise<>, etc.) — reuse shared utility
		const simpleType = extractReturnTypeName(typeName) ?? typeName;
		if (!simpleType) return;
		let fileExports = result.get(filePath);
		if (!fileExports) {
			fileExports = new Map();
			result.set(filePath, fileExports);
		}
		if (fileExports.size < MAX_EXPORTS_PER_FILE) {
			fileExports.set(name, simpleType);
		}
	});
	return result;
}

/** Seed cross-file receiver types into pre-extracted call records.
 *  Fills missing receiverTypeName for single-hop imported variables
 *  using ExportedTypeMap + namedImportMap — zero disk I/O, zero AST re-parsing.
 *  Mutates calls in-place. Runs BEFORE processCallsFromExtracted. */
export function seedCrossFileReceiverTypes(
	calls: ExtractedCall[],
	namedImportMap: ReadonlyMap<
		string,
		ReadonlyMap<string, { sourcePath: string; exportedName: string }>
	>,
	exportedTypeMap: ReadonlyMap<string, ReadonlyMap<string, string>>,
): { enrichedCount: number } {
	if (namedImportMap.size === 0 || exportedTypeMap.size === 0) {
		return { enrichedCount: 0 };
	}
	let enrichedCount = 0;
	for (const call of calls) {
		if (call.receiverTypeName || !call.receiverName) continue;
		if (call.callForm !== "member") continue;

		const fileImports = namedImportMap.get(call.filePath);
		if (!fileImports) continue;

		const binding = fileImports.get(call.receiverName);
		if (!binding) continue;

		const upstream = exportedTypeMap.get(binding.sourcePath);
		if (!upstream) continue;

		const type = upstream.get(binding.exportedName);
		if (type) {
			call.receiverTypeName = type;
			enrichedCount++;
		}
	}
	return { enrichedCount };
}

// Stdlib methods that preserve the receiver's type identity. When TypeEnv already
// strips nullable wrappers (Option<User> → User), these chain steps are no-ops
// for type resolution — the current type passes through unchanged.
export const TYPE_PRESERVING_METHODS = new Set([
	"unwrap",
	"expect",
	"unwrap_or",
	"unwrap_or_default",
	"unwrap_or_else", // Rust Option/Result
	"clone",
	"to_owned",
	"as_ref",
	"as_mut",
	"borrow",
	"borrow_mut", // Rust clone/borrow
	"get", // Kotlin/Java Optional.get()
	"orElseThrow", // Java Optional
]);

/** Cache for method extraction results in findEnclosingFunction fallback path.
 *  Keyed by classNode.id to avoid re-extracting the same class body per call site.
 *  Cleared between files at line ~611 in the processCalls file loop. */
export const enclosingFnExtractCache = new Map<
	number,
	import("../method-types.js").ExtractedMethods | null
>();

/**
 * Walk up the AST from a node to find the enclosing function/method.
 * Returns null if the call is at module/file level (top-level code).
 */
export const findEnclosingFunction = (
	node: SyntaxNode,
	filePath: string,
	ctx: ResolutionContext,
	provider: import("../language-provider.js").LanguageProvider,
): string | null => {
	let current = node.parent;

	while (current) {
		if (FUNCTION_NODE_TYPES.has(current.type)) {
			const efnResult = provider.methodExtractor?.extractFunctionName?.(current);
			const funcName = efnResult?.funcName ?? genericFuncName(current);
			const label = efnResult?.label ?? inferFunctionLabel(current.type);

			if (funcName) {
				const resolved = ctx.resolve(funcName, filePath);
				if (resolved?.tier === "same-file" && resolved.candidates.length > 0) {
					// Disambiguate by enclosing class when multiple candidates
					if (resolved.candidates.length === 1) {
						return resolved.candidates[0].nodeId;
					}
					const classInfo = findEnclosingClassInfo(current, filePath);
					if (classInfo) {
						const classMatches = resolved.candidates.filter(
							(c) => c.ownerId === classInfo.classId,
						);
						// Unique class match — return it (no same-arity ambiguity)
						if (classMatches.length === 1) return classMatches[0].nodeId;
						// Multiple same-class candidates (same-arity overloads) — fall through
						// to the fallback path which computes the exact ID with type-hash.
						if (classMatches.length > 1) {
							/* fall through to manual ID construction below */
						} else {
							// No class match — return first candidate as before
							return resolved.candidates[0].nodeId;
						}
					} else {
						return resolved.candidates[0].nodeId;
					}
				}

				// Fallback: qualify the generated ID to match definition-phase node IDs
				let finalLabel = label;
				if (provider.labelOverride) {
					const override = provider.labelOverride(current, label);
					if (override !== null) finalLabel = override;
				}
				const classInfo2 = findEnclosingClassInfo(current, filePath);
				const qualifiedName = classInfo2
					? `${classInfo2.className}.${funcName}`
					: funcName;
				// Include #<arity> and ~typeTag suffix to match definition-phase Method/Constructor IDs.
				const language = getLanguageFromFilename(filePath);
				let arity: number | undefined;
				let encTypeTag = "";
				if (
					(finalLabel === "Method" || finalLabel === "Constructor") &&
					provider.methodExtractor &&
					language
				) {
					// Get class method map (cached per classNode.id) and look up current method
					// by funcName:line. This avoids per-call-site extractFromNode AST walks.
					let classNode = current.parent;
					while (
						classNode &&
						!provider.methodExtractor.isTypeDeclaration(classNode)
					) {
						classNode = classNode.parent;
					}
					let info: MethodInfo | undefined;
					if (classNode) {
						let extracted = enclosingFnExtractCache.get(classNode.id);
						if (extracted === undefined) {
							extracted =
								provider.methodExtractor.extract(classNode, { filePath, language }) ??
								null;
							enclosingFnExtractCache.set(classNode.id, extracted);
						}
						if (extracted?.methods?.length) {
							const defLine = current.startPosition.row + 1;
							info = extracted.methods.find(
								(m) => m.name === funcName && m.line === defLine,
							);
							if (info) {
								arity = info.parameters.some((p) => p.isVariadic)
									? undefined
									: info.parameters.length;
							}
							if (arity !== undefined && info) {
								const methodMap = new Map<string, MethodInfo>();
								for (const m of extracted.methods)
									methodMap.set(`${m.name}:${m.line}`, m);
								const groups = buildCollisionGroups(methodMap);
								encTypeTag =
									typeTagForId(methodMap, funcName, arity, info, language, groups) +
									constTagForId(methodMap, funcName, arity, info, groups);
							}
						}
					}
					// Fallback: extractFromNode for top-level methods without a class
					if (!info && provider.methodExtractor.extractFromNode) {
						const nodeInfo = provider.methodExtractor.extractFromNode(current, {
							filePath,
							language,
						});
						if (nodeInfo) {
							arity = nodeInfo.parameters.some((p) => p.isVariadic)
								? undefined
								: nodeInfo.parameters.length;
						}
					}
				}
				const arityTag = arity !== undefined ? `#${arity}${encTypeTag}` : "";
				return generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag}`);
			}
		}

		// Language-specific enclosing function resolution (e.g., Dart where
		// function_body is a sibling of function_signature, not a child).
		if (provider.enclosingFunctionFinder) {
			const customResult = provider.enclosingFunctionFinder(current);
			if (customResult) {
				const resolved = ctx.resolve(customResult.funcName, filePath);
				if (resolved?.tier === "same-file" && resolved.candidates.length > 0) {
					if (resolved.candidates.length === 1) {
						return resolved.candidates[0].nodeId;
					}
					const classInfo = findEnclosingClassInfo(
						current.previousSibling ?? current,
						filePath,
					);
					if (classInfo) {
						const classMatches = resolved.candidates.filter(
							(c) => c.ownerId === classInfo.classId,
						);
						if (classMatches.length === 1) return classMatches[0].nodeId;
						if (classMatches.length > 1) {
							/* fall through to manual ID construction below */
						} else {
							return resolved.candidates[0].nodeId;
						}
					} else {
						return resolved.candidates[0].nodeId;
					}
				}
				let finalLabel = customResult.label;
				if (provider.labelOverride) {
					const override = provider.labelOverride(
						current.previousSibling!,
						finalLabel,
					);
					if (override !== null) finalLabel = override;
				}
				const classInfo2 = findEnclosingClassInfo(
					current.previousSibling ?? current,
					filePath,
				);
				const qualifiedName = classInfo2
					? `${classInfo2.className}.${customResult.funcName}`
					: customResult.funcName;
				// Include #<arity> and ~typeTag suffix to match definition-phase Method/Constructor IDs.
				const sigNode = current.previousSibling ?? current;
				const language2 = getLanguageFromFilename(filePath);
				let arity2: number | undefined;
				let encTypeTag2 = "";
				if (
					(finalLabel === "Method" || finalLabel === "Constructor") &&
					provider.methodExtractor &&
					language2
				) {
					let classNode2 = (current.previousSibling ?? current).parent;
					while (
						classNode2 &&
						!provider.methodExtractor.isTypeDeclaration(classNode2)
					) {
						classNode2 = classNode2.parent;
					}
					let info2: MethodInfo | undefined;
					if (classNode2) {
						let extracted2 = enclosingFnExtractCache.get(classNode2.id);
						if (extracted2 === undefined) {
							extracted2 =
								provider.methodExtractor.extract(classNode2, {
									filePath,
									language: language2,
								}) ?? null;
							enclosingFnExtractCache.set(classNode2.id, extracted2);
						}
						if (extracted2?.methods?.length) {
							const defLine2 = sigNode.startPosition.row + 1;
							info2 = extracted2.methods.find(
								(m) => m.name === customResult.funcName && m.line === defLine2,
							);
							if (info2) {
								arity2 = info2.parameters.some((p) => p.isVariadic)
									? undefined
									: info2.parameters.length;
							}
							if (arity2 !== undefined && info2) {
								const methodMap = new Map<string, MethodInfo>();
								for (const m of extracted2.methods)
									methodMap.set(`${m.name}:${m.line}`, m);
								const groups2 = buildCollisionGroups(methodMap);
								encTypeTag2 =
									typeTagForId(
										methodMap,
										customResult.funcName,
										arity2,
										info2,
										language2,
										groups2,
									) +
									constTagForId(
										methodMap,
										customResult.funcName,
										arity2,
										info2,
										groups2,
									);
							}
						}
					}
					if (!info2 && provider.methodExtractor.extractFromNode) {
						const nodeInfo = provider.methodExtractor.extractFromNode(sigNode, {
							filePath,
							language: language2,
						});
						if (nodeInfo) {
							arity2 = nodeInfo.parameters.some((p) => p.isVariadic)
								? undefined
								: nodeInfo.parameters.length;
						}
					}
				}
				const arityTag2 = arity2 !== undefined ? `#${arity2}${encTypeTag2}` : "";
				return generateId(finalLabel, `${filePath}:${qualifiedName}${arityTag2}`);
			}
		}

		current = current.parent;
	}

	return null;
};

/**
 * Verify constructor bindings against SymbolTable and infer receiver types.
 * Shared between sequential (processCalls) and worker (processCallsFromExtracted) paths.
 */
export const verifyConstructorBindings = (
	bindings: readonly ConstructorBinding[],
	filePath: string,
	ctx: ResolutionContext,
	graph?: KnowledgeGraph,
	bindingAccumulator?: BindingAccumulator,
): Map<string, string> => {
	const verified = new Map<string, string>();

	for (const { scope, varName, calleeName, receiverClassName } of bindings) {
		const tiered = ctx.resolve(calleeName, filePath);
		const isClass =
			tiered?.candidates.some((def) => def.type === "Class") ?? false;

		if (isClass) {
			verified.set(receiverKey(scope, varName), calleeName);
		} else {
			let callableDefs = tiered?.candidates.filter(
				(d) => d.type === "Function" || d.type === "Method",
			);

			// When receiver class is known (e.g. $this->method() in PHP), narrow
			// candidates to methods owned by that class to avoid false disambiguation failures.
			if (callableDefs && callableDefs.length > 1 && receiverClassName) {
				if (graph) {
					// Worker path: use graph.getNode (fast, already in-memory)
					const narrowed = callableDefs.filter((d) => {
						if (!d.ownerId) return false;
						const owner = graph.getNode(d.ownerId);
						return owner?.properties.name === receiverClassName;
					});
					if (narrowed.length > 0) callableDefs = narrowed;
				} else {
					// Sequential path: use ctx.resolve (no graph available)
					const classResolved = ctx.resolve(receiverClassName, filePath);
					if (classResolved && classResolved.candidates.length > 0) {
						const classNodeIds = new Set(
							classResolved.candidates.map((c) => c.nodeId),
						);
						const narrowed = callableDefs.filter(
							(d) => d.ownerId && classNodeIds.has(d.ownerId),
						);
						if (narrowed.length > 0) callableDefs = narrowed;
					}
				}
			}

			let typeName: string | undefined;
			if (
				callableDefs &&
				callableDefs.length === 1 &&
				callableDefs[0].returnType
			) {
				typeName = extractReturnTypeName(callableDefs[0].returnType);
			}

			// Phase 9: BindingAccumulator fallback for cross-file return types.
			// Used when the SymbolTable has no return type for a cross-file callee
			// (e.g., a return type that TypeEnv resolved via fixpoint in the source
			// file but was not stored as a SymbolTable returnType annotation).
			// namedImportMap tells us which source file exported the callee so we
			// can look up its file-scope binding via the O(1) fileScopeGet method.
			//
			// Tier gating: only fall back to the accumulator when resolution is
			// unambiguously import-scoped or global. When tiered.tier is 'same-file',
			// the local definition is authoritative even without a return type
			// annotation — using the accumulator here would let an imported callee
			// with the same name shadow the local one, producing false CALLS edges.
			// When multiple callable candidates exist, the accumulator would pick
			// arbitrarily — skip to avoid fabricated edges.
			//
			// Quality note: worker-path accumulator entries are Tier 0/1 only
			// (annotation-declared + same-file constructor inference) — see the
			// BindingAccumulator class JSDoc. For large repos where the worker
			// path dominates, Phase 9 binding accuracy is structurally lower
			// than for sequential-path repos where Tier 2 cross-file propagation
			// is available.
			//
			// Overlapping mechanism note: this is one of three cross-file
			// return-type resolution paths in the codebase:
			//   1. buildImportedReturnTypes (~line 109) — namedImportMap +
			//      SymbolTable.lookupExactFull (structure-processor captured)
			//   2. collectExportedBindings (~line 168) / enrichExportedTypeMap
			//      — TypeEnv + graph isExported flag
			//   3. This fallback — namedImportMap + BindingAccumulator
			// A future cleanup should merge these into a single resolution pass.
			const shouldFallback =
				tiered?.tier !== "same-file" && (!callableDefs || callableDefs.length <= 1);
			if (!typeName && bindingAccumulator && shouldFallback) {
				const namedImports = ctx.namedImportMap.get(filePath);
				const importBinding = namedImports?.get(calleeName);
				if (importBinding) {
					const rawType = bindingAccumulator.fileScopeGet(
						importBinding.sourcePath,
						importBinding.exportedName,
					);
					if (rawType) {
						typeName = extractReturnTypeName(rawType);
					}
				}
			}

			if (typeName) {
				verified.set(receiverKey(scope, varName), typeName);
			}
		}
	}

	return verified;
};

/**
 * Resolution result with confidence scoring
 */
export interface ResolveResult {
	nodeId: string;
	confidence: number;
	reason: string;
	returnType?: string;
}

/**
 * After resolving a call to an interface method, find additional targets
 * in classes implementing that interface. Returns implementation method
 * results with lower confidence ('interface-dispatch').
 */
export function findInterfaceDispatchTargets(
	calledName: string,
	receiverTypeName: string,
	currentFile: string,
	ctx: ResolutionContext,
	heritageMap: HeritageMap,
	primaryNodeId: string,
): ResolveResult[] {
	const implFiles = heritageMap.getImplementorFiles(receiverTypeName);
	if (implFiles.size === 0) return [];

	const typeResolved = ctx.resolve(receiverTypeName, currentFile);
	if (!typeResolved) return [];
	if (!typeResolved.candidates.some((c) => c.type === "Interface")) return [];

	const results: ResolveResult[] = [];
	for (const implFile of implFiles) {
		const methods = ctx.model.symbols.lookupExactAll(implFile, calledName);
		for (const method of methods) {
			if (method.nodeId !== primaryNodeId) {
				results.push({
					nodeId: method.nodeId,
					confidence: 0.7,
					reason: "interface-dispatch",
				});
			}
		}
	}
	return results;
}
