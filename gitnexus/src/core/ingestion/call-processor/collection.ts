import {
	CLASS_LIKE_TYPES,
	FUNCTION_NODE_TYPES,
	Parser,
	SupportedLanguages,
	buildTypeEnv,
	countCallArguments,
	defaultDispatchDecision,
	extractMixedChain,
	extractReceiverName,
	extractReceiverNode,
	generateId,
	genericFuncName,
	getLanguageFromFilename,
	getProvider,
	getTreeSitterBufferSize,
	inferCallForm,
	isLanguageAvailable,
	isRegistryPrimary,
	isSubclassOf,
	isVerboseIngestionEnabled,
	loadLanguage,
	loadParser,
	logger,
	parseSourceSafe,
	yieldToEventLoop,
} from "./context.js";
import type {
	ASTCache,
	BindingAccumulator,
	DispatchDecision,
	ExportedTypeMap,
	ExtractedHeritage,
	HeritageMap,
	KnowledgeGraph,
	ReceiverSource,
	ResolutionContext,
} from "./context.js";
import {
	collectExportedBindings,
	enclosingFnExtractCache,
	findEnclosingFunction,
	findInterfaceDispatchTargets,
	verifyConstructorBindings,
} from "./type-inference.js";
import {
	buildReceiverTypeIndex,
	extractFuncNameFromSourceId,
	lookupReceiverType,
	makeAccessEmitter,
} from "./receiver-member.js";
import { walkMixedChain } from "./receiver-chain.js";
import { resolveCallTarget } from "./coordinator.js";
import {
	emitDeferredWriteAccesses,
	registerRoutedProperties,
} from "./collection-properties.js";
import type { PendingWrite, PreparedFile } from "./collection-properties.js";
import { emitVueTemplateComponentCalls } from "./collection-vue.js";
import type { OverloadHints, WidenCache } from "./overload-path.js";

export const processCalls = async (
	graph: KnowledgeGraph,
	files: { path: string; content: string }[],
	astCache: ASTCache,
	ctx: ResolutionContext,
	onProgress?: (current: number, total: number) => void,
	exportedTypeMap?: ExportedTypeMap,
	/** Phase 14: pre-resolved cross-file bindings to seed into buildTypeEnv. Keyed by filePath → Map<localName, typeName>. */
	importedBindingsMap?: ReadonlyMap<string, ReadonlyMap<string, string>>,
	/** Phase 14 E3: cross-file return types for imported callables. Keyed by filePath → Map<calleeName, returnType>.
	 *  Consulted ONLY when SymbolTable has no unambiguous match (local-first principle). */
	importedReturnTypesMap?: ReadonlyMap<string, ReadonlyMap<string, string>>,
	/** Phase 14 E3: cross-file RAW return types for for-loop element extraction. Keyed by filePath → Map<calleeName, rawReturnType>. */
	importedRawReturnTypesMap?: ReadonlyMap<string, ReadonlyMap<string, string>>,
	heritageMap?: HeritageMap,
	bindingAccumulator?: BindingAccumulator,
	/**
	 * Optional cache for compiled `Parser.Query` objects keyed by language name.
	 * When provided, compiled queries are reused across calls instead of being
	 * re-compiled from the query string for every file. Callers that invoke
	 * `processCalls` many times with single-file batches (e.g. the cross-file
	 * propagation phase) should pass a long-lived map here to avoid O(N)
	 * query recompilation overhead.
	 */
	compiledQueryCache?: Map<SupportedLanguages, Parser.Query>,
): Promise<ExtractedHeritage[]> => {
	const parser = await loadParser();
	const collectedHeritage: ExtractedHeritage[] = [];
	const pendingWrites: PendingWrite[] = [];
	// Phase P cross-file: accumulate heritage across files for cross-file isSubclassOf.
	// Used as a secondary check when per-file parentMap lacks the relationship — helps
	// when the heritage-declaring file is processed before the call site file.
	// For remaining cases (reverse file order), the SymbolTable class-type fallback applies.
	const globalParentMap = new Map<string, string[]>();
	const globalParentSeen = new Map<string, Set<string>>();
	const logSkipped = isVerboseIngestionEnabled();
	const skippedByLang = logSkipped ? new Map<string, number>() : null;

	// ── Prepare-then-resolve: single preparation loop, deferred resolution ──
	// All files are prepared (parse → query → heritage → TypeEnv) in one loop,
	// then resolved (verifyConstructorBindings → call edges) in a second loop.
	// This ensures:
	//   1. When bindingAccumulator is present, ALL files flush their TypeEnv
	//      bindings before ANY verifyConstructorBindings reads — fixing the
	//      consumer-before-provider ordering bug on the sequential path.
	//   2. globalParentMap is fully populated before resolution, improving
	//      cross-file isSubclassOf accuracy regardless of file order.
	// For the sequential path (<15 files), buffering per-file state is negligible.
	const prepared: PreparedFile[] = [];

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		if (i % 20 === 0) await yieldToEventLoop();

		const language = getLanguageFromFilename(file.path);
		if (!language) continue;
		// Registry-primary gate: scope-based phase owns CALLS for this lang.
		if (isRegistryPrimary(language)) continue;
		if (!isLanguageAvailable(language)) {
			if (skippedByLang) {
				skippedByLang.set(language, (skippedByLang.get(language) ?? 0) + 1);
			}
			continue;
		}

		const provider = getProvider(language);
		const queryStr = provider.treeSitterQueries;
		if (!queryStr) continue;

		await loadLanguage(language, file.path);

		let tree = astCache.get(file.path);
		if (!tree) {
			const parseContent =
				provider.preprocessSource?.(file.content, file.path) ?? file.content;
			try {
				tree = parseSourceSafe(parser, parseContent, undefined, {
					bufferSize: getTreeSitterBufferSize(parseContent),
				});
			} catch (_parseError) {
				continue;
			}
			astCache.set(file.path, tree);
		}

		let matches;
		try {
			const lang = parser.getLanguage();
			let query = compiledQueryCache?.get(language);
			if (!query) {
				query = new Parser.Query(lang, queryStr);
				compiledQueryCache?.set(language, query);
			}
			matches = query.matches(tree.rootNode);
		} catch (queryError) {
			logger.warn({ queryError }, `Query error for ${file.path}:`);
			continue;
		}

		// Extract heritage from query matches to build parentMap for buildTypeEnv.
		// Heritage-processor runs in PARALLEL, so graph edges don't exist when buildTypeEnv runs.
		const fileParentMap = new Map<string, string[]>();
		if (provider.heritageExtractor) {
			for (const match of matches) {
				const captureMap: Record<string, any> = {};
				match.captures.forEach((c) => (captureMap[c.name] = c.node));
				if (captureMap["heritage.class"]) {
					const heritageItems = provider.heritageExtractor.extract(captureMap, {
						filePath: file.path,
						language,
					});
					for (const item of heritageItems) {
						if (item.kind === "extends") {
							let parents = fileParentMap.get(item.className);
							if (!parents) {
								parents = [];
								fileParentMap.set(item.className, parents);
							}
							if (!parents.includes(item.parentName)) parents.push(item.parentName);
						}
					}
				}
			}
		}
		const parentMap: ReadonlyMap<string, readonly string[]> = fileParentMap;
		// Merge per-file heritage into globalParentMap for cross-file isSubclassOf lookups.
		for (const [cls, parents] of fileParentMap) {
			let global = globalParentMap.get(cls);
			let seen = globalParentSeen.get(cls);
			if (!global) {
				global = [];
				globalParentMap.set(cls, global);
			}
			if (!seen) {
				seen = new Set();
				globalParentSeen.set(cls, seen);
			}
			for (const p of parents) {
				if (!seen.has(p)) {
					seen.add(p);
					global.push(p);
				}
			}
		}

		const importedBindings = importedBindingsMap?.get(file.path);
		const importedReturnTypes = importedReturnTypesMap?.get(file.path);
		const importedRawReturnTypes = importedRawReturnTypesMap?.get(file.path);
		const typeEnv = buildTypeEnv(tree, language, {
			model: ctx.model,
			parentMap,
			importedBindings,
			importedReturnTypes,
			importedRawReturnTypes,
			enclosingFunctionFinder: provider?.enclosingFunctionFinder,
			extractFunctionName: provider?.methodExtractor?.extractFunctionName,
		});
		if (typeEnv && exportedTypeMap) {
			const fileExports = collectExportedBindings(
				typeEnv,
				file.path,
				ctx.model.symbols,
				graph,
			);
			if (fileExports) exportedTypeMap.set(file.path, fileExports);
		}
		if (bindingAccumulator) {
			typeEnv.flush(file.path, bindingAccumulator);
		}

		prepared.push({
			file,
			language,
			provider,
			tree,
			matches,
			parentMap,
			typeEnv,
		});
	}

	// ── Property-registration pre-pass ──
	// Register all routed properties (e.g. Ruby attr_accessor) BEFORE the
	// resolution loop so cross-file field-type lookups (e.g.
	// `user.address.save → Address#save`) succeed regardless of file
	// processing order. This MUST stay in lockstep with the equivalent
	// worker-path block in parse-worker.ts (kind === 'properties') — any
	// divergence between the two paths breaks the `incremental ≡ --force`
	// invariant once a repo crosses the worker threshold between runs.
	registerRoutedProperties(graph, prepared, ctx);

	// ── Resolution loop: verify constructor bindings and resolve calls ──
	// The accumulator (if present) is now fully populated from the preparation
	// loop above, so verifyConstructorBindings sees all provider bindings
	// regardless of file processing order.
	for (let i = 0; i < prepared.length; i++) {
		const { file, language, provider, tree, matches, parentMap, typeEnv } =
			prepared[i];

		enclosingFnExtractCache.clear();
		onProgress?.(i + 1, files.length);
		if (i % 20 === 0) await yieldToEventLoop();

		const callRouter = provider.callRouter;

		const verifiedReceivers =
			typeEnv.constructorBindings.length > 0
				? verifyConstructorBindings(
						typeEnv.constructorBindings,
						file.path,
						ctx,
						undefined, // graph not available on the sequential path here
						bindingAccumulator, // Phase 9 fallback — same as worker path (R3 parity)
					)
				: new Map<string, string>();
		const receiverIndex = buildReceiverTypeIndex(verifiedReceivers);

		ctx.enableCache(file.path);
		const widenCache: WidenCache = new Map();

		matches.forEach((match) => {
			const captureMap: Record<string, any> = {};
			match.captures.forEach((c) => (captureMap[c.name] = c.node));
			// ── Write access: emit ACCESSES {reason: 'write'} for assignments to member fields ──
			if (
				captureMap.assignment &&
				captureMap["assignment.receiver"] &&
				captureMap["assignment.property"]
			) {
				const receiverNode = captureMap["assignment.receiver"];
				const propertyName: string = captureMap["assignment.property"].text;
				// Resolve receiver type: simple identifier → TypeEnv lookup or class resolution
				let receiverTypeName: string | undefined;
				const receiverText = receiverNode.text;
				if (receiverText && typeEnv) {
					receiverTypeName = typeEnv.lookup(receiverText, captureMap.assignment);
				}
				// Fall back to verified constructor bindings (mirrors CALLS resolution tier 2)
				if (!receiverTypeName && receiverText && receiverIndex.size > 0) {
					const enclosing = findEnclosingFunction(
						captureMap.assignment,
						file.path,
						ctx,
						provider,
					);
					const funcName = enclosing ? extractFuncNameFromSourceId(enclosing) : "";
					receiverTypeName = lookupReceiverType(
						receiverIndex,
						funcName,
						receiverText,
					);
				}
				if (!receiverTypeName && receiverText) {
					const resolved = ctx.resolve(receiverText, file.path);
					if (resolved?.candidates.some((d) => CLASS_LIKE_TYPES.has(d.type))) {
						receiverTypeName = receiverText;
					}
				}
				if (receiverTypeName) {
					const enclosing = findEnclosingFunction(
						captureMap.assignment,
						file.path,
						ctx,
						provider,
					);
					const srcId = enclosing || generateId("File", file.path);
					// Defer resolution: Ruby attr_accessor properties are registered during
					// this same loop, so cross-file lookups fail if the declaring file hasn't
					// been processed yet. Collect now, resolve after all files are done.
					pendingWrites.push({
						receiverTypeName,
						propertyName,
						filePath: file.path,
						srcId,
						line: captureMap.assignment.startPosition.row + 1,
					});
				}
				// Assignment-only capture (no @call sibling): skip the rest of this
				// forEach iteration — this acts as a `continue` in the match loop.
				if (!captureMap.call) return;
			}

			if (!captureMap.call) return;

			const callNode = captureMap.call;
			const callExtractor = provider.callExtractor;

			// ── Language-specific call site (e.g. Java :: method references) ──
			if (callExtractor) {
				const langCallSite = callExtractor.extract(callNode, undefined);
				if (langCallSite) {
					if (provider.isBuiltInName(langCallSite.calledName)) return;

					const sourceId =
						findEnclosingFunction(callNode, file.path, ctx, provider) ||
						generateId("File", file.path);
					const receiverName =
						langCallSite.callForm === "member"
							? langCallSite.receiverName
							: undefined;
					let receiverTypeName =
						receiverName && typeEnv
							? typeEnv.lookup(receiverName, callNode)
							: undefined;

					if (
						langCallSite.typeAsReceiverHeuristic &&
						receiverName !== undefined &&
						receiverTypeName === undefined &&
						langCallSite.callForm === "member"
					) {
						const c0 = receiverName.charCodeAt(0);
						if (c0 >= 65 && c0 <= 90) receiverTypeName = receiverName;
					}

					const resolved = resolveCallTarget(
						{
							calledName: langCallSite.calledName,
							callForm: langCallSite.callForm,
							...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
							...(receiverName !== undefined ? { receiverName } : {}),
						},
						file.path,
						ctx,
						undefined,
						widenCache,
						undefined,
						heritageMap,
					);

					if (!resolved) return;
					graph.addRelationship({
						id: generateId(
							"CALLS",
							`${sourceId}:${langCallSite.calledName}->${resolved.nodeId}`,
						),
						sourceId,
						targetId: resolved.nodeId,
						type: "CALLS",
						confidence: resolved.confidence,
						reason: resolved.reason,
					});

					if (
						heritageMap &&
						langCallSite.callForm === "member" &&
						receiverTypeName
					) {
						const implTargets = findInterfaceDispatchTargets(
							langCallSite.calledName,
							receiverTypeName,
							file.path,
							ctx,
							heritageMap,
							resolved.nodeId,
						);
						for (const impl of implTargets) {
							graph.addRelationship({
								id: generateId(
									"CALLS",
									`${sourceId}:${langCallSite.calledName}->${impl.nodeId}`,
								),
								sourceId,
								targetId: impl.nodeId,
								type: "CALLS",
								confidence: impl.confidence,
								reason: impl.reason,
							});
						}
					}
					return;
				}
			}

			const nameNode = captureMap["call.name"];
			if (!nameNode) return;

			const calledName = nameNode.text;

			// Check heritage extractor for call-based heritage (e.g., Ruby include/extend/prepend)
			if (provider.heritageExtractor?.extractFromCall) {
				const heritageItems = provider.heritageExtractor.extractFromCall(
					calledName,
					captureMap.call,
					{ filePath: file.path, language },
				);
				if (heritageItems !== null) {
					for (const item of heritageItems) {
						collectedHeritage.push({
							filePath: file.path,
							className: item.className,
							parentName: item.parentName,
							kind: item.kind,
						});
					}
					return;
				}
			}

			// Dispatch: route language-specific calls (properties, imports)
			// Heritage routing is handled by heritageExtractor.extractFromCall above.
			const routed = callRouter?.(calledName, captureMap.call);
			if (routed) {
				switch (routed.kind) {
					case "skip":
					case "import":
						return;

					case "properties": {
						// Properties already registered in the pre-pass above.
						// Skip to avoid duplicate nodes/edges.
						return;
					}

					case "call":
						break;
				}
			}

			if (provider.isBuiltInName(calledName)) return;

			// --- DAG stage 2-3: classify-form + infer-receiver (shared defaults) ---
			// These stages run the shared inference chain. Language providers can
			// customize infer-receiver (stage 3) via the inferImplicitReceiver hook
			// which runs AFTER this default chain (typed-binding → constructor-map →
			// module-alias → class-as-receiver → mixed-chain), and selectDispatch
			// (stage 4) which picks the resolver branch.
			let callForm = inferCallForm(callNode, nameNode);
			let receiverName =
				callForm === "member" ? extractReceiverName(nameNode) : undefined;
			let receiverTypeName =
				receiverName && typeEnv
					? typeEnv.lookup(receiverName, callNode)
					: undefined;
			let receiverSource: ReceiverSource = receiverTypeName
				? "typed-binding"
				: "none";
			// Phase P: virtual dispatch override — when the declared type is a base class but
			// the constructor created a known subclass, prefer the more specific type.
			// Checks per-file parentMap first, then falls back to globalParentMap for
			// cross-file heritage (e.g. Dog extends Animal declared in a different file).
			// Reconstructs the exact scope key (funcName@startIndex\0varName) from the
			// enclosing function AST node for a correct, O(1) map lookup.
			if (
				receiverTypeName &&
				receiverName &&
				typeEnv &&
				typeEnv.constructorTypeMap.size > 0
			) {
				// Reconstruct scope key to match constructorTypeMap's scope\0varName format
				let scope = "";
				let p = callNode.parent;
				while (p) {
					if (FUNCTION_NODE_TYPES.has(p.type)) {
						const funcName =
							provider.methodExtractor?.extractFunctionName?.(p)?.funcName ??
							genericFuncName(p);
						if (funcName) {
							scope = `${funcName}@${p.startIndex}`;
							break;
						}
					}
					p = p.parent;
				}
				const ctorType = typeEnv.constructorTypeMap.get(
					`${scope}\0${receiverName}`,
				);
				if (ctorType && ctorType !== receiverTypeName) {
					// Verify subclass relationship: per-file parentMap first, then cross-file
					// globalParentMap, then fall back to SymbolTable class verification.
					// The SymbolTable fallback handles cross-file cases where heritage is declared
					// in a file not yet processed (e.g. Dog extends Animal in models/Dog.kt when
					// processing services/App.kt). Since constructorTypeMap only records entries
					// when a type annotation AND constructor are both present (val x: Base = Sub()),
					// confirming both are class-like types is sufficient — the original code would
					// not compile if Sub didn't extend Base.
					if (
						isSubclassOf(ctorType, receiverTypeName, parentMap) ||
						isSubclassOf(ctorType, receiverTypeName, globalParentMap) ||
						(ctx.model.types.lookupClassByName(ctorType).length > 0 &&
							ctx.model.types.lookupClassByName(receiverTypeName).length > 0)
					) {
						receiverTypeName = ctorType;
						receiverSource = "constructor-map";
					}
				}
			}
			// Fall back to verified constructor bindings for return type inference
			if (!receiverTypeName && receiverName && receiverIndex.size > 0) {
				const enclosingFunc = findEnclosingFunction(
					callNode,
					file.path,
					ctx,
					provider,
				);
				const funcName = enclosingFunc
					? extractFuncNameFromSourceId(enclosingFunc)
					: "";
				receiverTypeName = lookupReceiverType(
					receiverIndex,
					funcName,
					receiverName,
				);
				if (receiverTypeName) receiverSource = "constructor-map";
			}
			// Fall back to class-as-receiver for static method calls (e.g. UserService.find_user(),
			// Greetable.format()). When the receiver name is not a variable in TypeEnv but
			// resolves to a class-like symbol (Class / Interface / Struct / Enum / Trait) via
			// tiered resolution, use it directly as the receiver type. `Trait` is included so
			// Ruby module class-method calls flow through the class-as-receiver path and reach
			// the `selectDispatch` hook's singleton branch.
			if (!receiverTypeName && receiverName && callForm === "member") {
				const typeResolved = ctx.resolve(receiverName, file.path);
				if (
					typeResolved?.candidates.some(
						(d) =>
							d.type === "Class" ||
							d.type === "Interface" ||
							d.type === "Struct" ||
							d.type === "Enum" ||
							d.type === "Trait",
					)
				) {
					receiverTypeName = receiverName;
					receiverSource = "class-as-receiver";
				}
			}
			// Hoist sourceId so it's available for ACCESSES edge emission during chain walk.
			const enclosingFuncId = findEnclosingFunction(
				callNode,
				file.path,
				ctx,
				provider,
			);
			const sourceId = enclosingFuncId || generateId("File", file.path);

			// Fall back to mixed chain resolution when the receiver is a complex expression
			// (field chain, call chain, or interleaved — e.g. user.address.city.save() or
			// svc.getUser().address.save()). Handles all cases with a single unified walk.
			if (callForm === "member" && !receiverTypeName && !receiverName) {
				const receiverNode = extractReceiverNode(nameNode);
				if (receiverNode) {
					const extracted = extractMixedChain(receiverNode);
					if (extracted && extracted.chain.length > 0) {
						let currentType =
							extracted.baseReceiverName && typeEnv
								? typeEnv.lookup(extracted.baseReceiverName, callNode)
								: undefined;
						if (
							!currentType &&
							extracted.baseReceiverName &&
							receiverIndex.size > 0
						) {
							const funcName = enclosingFuncId
								? extractFuncNameFromSourceId(enclosingFuncId)
								: "";
							currentType = lookupReceiverType(
								receiverIndex,
								funcName,
								extracted.baseReceiverName,
							);
						}
						if (!currentType && extracted.baseReceiverName) {
							const cr = ctx.resolve(extracted.baseReceiverName, file.path);
							if (
								cr?.candidates.some(
									(d) =>
										d.type === "Class" ||
										d.type === "Interface" ||
										d.type === "Struct" ||
										d.type === "Enum",
								)
							) {
								currentType = extracted.baseReceiverName;
							}
						}
						if (currentType) {
							receiverTypeName = walkMixedChain(
								extracted.chain,
								currentType,
								file.path,
								ctx,
								makeAccessEmitter(graph, sourceId),
								heritageMap,
							);
							if (receiverTypeName) receiverSource = "mixed-chain";
						}
					}
				}
			}

			// --- DAG stage 3: infer-receiver (provider hook) ---
			// Synthesize implicit receivers for languages that omit them (e.g., Ruby bare-call).
			// This hook runs AFTER the shared inference chain so explicit receivers /
			// typed bindings always take precedence. Output (if non-null) overlays onto
			// the ReceiverEnriched for the next stage.
			let dispatchHint: string | undefined;
			if (provider.inferImplicitReceiver) {
				const override = provider.inferImplicitReceiver({
					calledName,
					callForm,
					receiverName,
					receiverTypeName,
					callNode,
					filePath: file.path,
				});
				if (override) {
					callForm = override.callForm;
					receiverName = override.receiverName;
					receiverTypeName = override.receiverTypeName;
					receiverSource = override.receiverSource;
					dispatchHint = override.hint;
				}
			}

			// --- DAG stage 4: select-dispatch (provider hook + default fallback) ---
			// Decide which resolver path to try first (primary) and fallback strategy.
			// Language providers can customize dispatch via selectDispatch hook; all
			// others use the shared defaultDispatchDecision. Always non-null after this
			// block so downstream resolvers are table-driven.
			const dispatchDecision: DispatchDecision =
				provider.selectDispatch?.({
					calledName,
					callForm,
					receiverName,
					receiverTypeName,
					receiverSource,
					hint: dispatchHint,
				}) ?? defaultDispatchDecision(callForm);

			// Build overload hints for languages with inferLiteralType (Java/Kotlin/C#/C++).
			// Only used when multiple candidates survive arity filtering — ~1-3% of calls.
			const langConfig = provider.typeConfig;
			const hints: OverloadHints | undefined = langConfig?.inferLiteralType
				? { callNode, inferLiteralType: langConfig.inferLiteralType, typeEnv }
				: undefined;

			const resolved = resolveCallTarget(
				{
					calledName,
					argCount: countCallArguments(callNode),
					callForm,
					receiverTypeName,
					receiverName,
				},
				file.path,
				ctx,
				hints,
				widenCache,
				undefined,
				heritageMap,
				dispatchDecision,
			);

			if (!resolved) return;
			const relId = generateId(
				"CALLS",
				`${sourceId}:${calledName}->${resolved.nodeId}`,
			);

			graph.addRelationship({
				id: relId,
				sourceId,
				targetId: resolved.nodeId,
				type: "CALLS",
				confidence: resolved.confidence,
				reason: resolved.reason,
			});

			if (heritageMap && callForm === "member" && receiverTypeName) {
				const implTargets = findInterfaceDispatchTargets(
					calledName,
					receiverTypeName,
					file.path,
					ctx,
					heritageMap,
					resolved.nodeId,
				);
				for (const impl of implTargets) {
					graph.addRelationship({
						id: generateId("CALLS", `${sourceId}:${calledName}->${impl.nodeId}`),
						sourceId,
						targetId: impl.nodeId,
						type: "CALLS",
						confidence: impl.confidence,
						reason: impl.reason,
					});
				}
			}
		});

		// Vue: emit CALLS edges for PascalCase components used in <template>.
		// Template components are default-imported (not named), so we match the
		// component name against imported .vue file basenames via the import map.
		if (language === SupportedLanguages.Vue) {
			emitVueTemplateComponentCalls(graph, file, ctx);
		}

		ctx.clearCache();
	}

	// ── Resolve deferred write-access edges ──
	// All properties (including Ruby attr_accessor) are now registered.
	emitDeferredWriteAccesses(graph, pendingWrites, ctx);

	if (skippedByLang && skippedByLang.size > 0) {
		for (const [lang, count] of skippedByLang.entries()) {
			logger.warn(
				`[ingestion] Skipped ${count} ${lang} file(s) in call processing — ${lang} parser not available.`,
			);
		}
	}

	return collectedHeritage;
};

// FREE_CALLABLE_TYPES imported from symbol-table.ts — single source of truth.
