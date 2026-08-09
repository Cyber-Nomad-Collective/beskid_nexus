import {
	CLASS_LIKE_TYPES,
	Parser,
	TIER_CONFIDENCE,
	generateId,
	getLanguageFromFilename,
	getProvider,
	getTreeSitterBufferSize,
	isLanguageAvailable,
	isRegistryPrimary,
	loadLanguage,
	loadParser,
	normalizeFetchURL,
	parseSourceSafe,
	routeMatches,
	yieldToEventLoop,
} from "./context.js";
import type {
	ASTCache,
	BindingAccumulator,
	ExtractedAssignment,
	ExtractedCall,
	ExtractedFetchCall,
	ExtractedRoute,
	FileConstructorBindings,
	HeritageMap,
	KnowledgeGraph,
	ResolutionContext,
} from "./context.js";
import {
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
import { resolveFieldOwnership } from "./receiver-fields.js";
import type { ReceiverTypeIndex } from "./receiver-member.js";
import { resolveCallTarget } from "./coordinator.js";
import type { WidenCache } from "./overload-path.js";

export const processCallsFromExtracted = async (
	graph: KnowledgeGraph,
	extractedCalls: ExtractedCall[],
	ctx: ResolutionContext,
	onProgress?: (current: number, total: number) => void,
	constructorBindings?: FileConstructorBindings[],
	heritageMap?: HeritageMap,
	bindingAccumulator?: BindingAccumulator,
) => {
	// Scope-aware receiver types: keyed by filePath → "funcName\0varName" → typeName.
	// The scope dimension prevents collisions when two functions in the same file
	// have same-named locals pointing to different constructor types.
	const fileReceiverTypes = new Map<string, ReceiverTypeIndex>();
	if (constructorBindings) {
		for (const { filePath, bindings } of constructorBindings) {
			const verified = verifyConstructorBindings(
				bindings,
				filePath,
				ctx,
				graph,
				bindingAccumulator,
			);
			if (verified.size > 0) {
				fileReceiverTypes.set(filePath, buildReceiverTypeIndex(verified));
			}
		}
	}

	const byFile = new Map<string, ExtractedCall[]>();
	for (const call of extractedCalls) {
		let list = byFile.get(call.filePath);
		if (!list) {
			list = [];
			byFile.set(call.filePath, list);
		}
		list.push(call);
	}
	const totalFiles = byFile.size;
	let filesProcessed = 0;

	for (const [filePath, calls] of byFile) {
		filesProcessed++;
		if (filesProcessed % 100 === 0) {
			onProgress?.(filesProcessed, totalFiles);
			await yieldToEventLoop();
		}

		// Registry-primary gate: skip Python (etc.) entirely when the
		// scope-based phase owns CALLS for this language.
		const fileLanguage = getLanguageFromFilename(filePath);
		if (fileLanguage && isRegistryPrimary(fileLanguage)) continue;

		ctx.enableCache(filePath);
		const widenCache: WidenCache = new Map();
		const receiverMap = fileReceiverTypes.get(filePath);

		for (const call of calls) {
			let effectiveCall = call;

			// Step 1: resolve receiver type from constructor bindings
			if (!call.receiverTypeName && call.receiverName && receiverMap) {
				const callFuncName = extractFuncNameFromSourceId(call.sourceId);
				const resolvedType = lookupReceiverType(
					receiverMap,
					callFuncName,
					call.receiverName,
				);
				if (resolvedType) {
					effectiveCall = { ...call, receiverTypeName: resolvedType };
				}
			}

			// Step 1b: class-as-receiver for static method calls (e.g. UserService.find_user())
			if (
				!effectiveCall.receiverTypeName &&
				effectiveCall.receiverName &&
				effectiveCall.callForm === "member"
			) {
				const typeResolved = ctx.resolve(
					effectiveCall.receiverName,
					effectiveCall.filePath,
				);
				if (
					typeResolved?.candidates.some(
						(d) =>
							d.type === "Class" ||
							d.type === "Interface" ||
							d.type === "Struct" ||
							d.type === "Enum",
					)
				) {
					effectiveCall = {
						...effectiveCall,
						receiverTypeName: effectiveCall.receiverName,
					};
				}
			}

			// Step 1c: mixed chain resolution (field, call, or interleaved — e.g. svc.getUser().address.save()).
			// Runs whenever receiverMixedChain is present. Steps 1/1b may have resolved the base receiver
			// type already; that type is used as the chain's starting point.
			if (effectiveCall.receiverMixedChain?.length) {
				// Use the already-resolved base type (from Steps 1/1b) or look it up now.
				let currentType: string | undefined = effectiveCall.receiverTypeName;
				if (!currentType && effectiveCall.receiverName && receiverMap) {
					const callFuncName = extractFuncNameFromSourceId(effectiveCall.sourceId);
					currentType = lookupReceiverType(
						receiverMap,
						callFuncName,
						effectiveCall.receiverName,
					);
				}
				if (!currentType && effectiveCall.receiverName) {
					const typeResolved = ctx.resolve(
						effectiveCall.receiverName,
						effectiveCall.filePath,
					);
					if (
						typeResolved?.candidates.some(
							(d) =>
								d.type === "Class" ||
								d.type === "Interface" ||
								d.type === "Struct" ||
								d.type === "Enum",
						)
					) {
						currentType = effectiveCall.receiverName;
					}
				}
				if (currentType) {
					const walkedType = walkMixedChain(
						effectiveCall.receiverMixedChain,
						currentType,
						effectiveCall.filePath,
						ctx,
						makeAccessEmitter(graph, effectiveCall.sourceId),
						heritageMap,
					);
					if (walkedType) {
						effectiveCall = { ...effectiveCall, receiverTypeName: walkedType };
					}
				}
			}

			const resolved = resolveCallTarget(
				effectiveCall,
				effectiveCall.filePath,
				ctx,
				undefined,
				widenCache,
				effectiveCall.argTypes,
				heritageMap,
			);
			if (!resolved) {
				// Vue template component fallback: match calledName against imported .vue basenames
				if (
					effectiveCall.filePath.endsWith(".vue") &&
					effectiveCall.sourceId.startsWith("File:")
				) {
					const importedFiles = ctx.importMap.get(effectiveCall.filePath);
					if (importedFiles) {
						for (const importedPath of importedFiles) {
							if (!importedPath.endsWith(".vue")) continue;
							const basename = importedPath.slice(
								importedPath.lastIndexOf("/") + 1,
								importedPath.lastIndexOf("."),
							);
							if (basename !== effectiveCall.calledName) continue;
							const targetFileId = generateId("File", importedPath);
							if (graph.getNode(targetFileId)) {
								graph.addRelationship({
									id: generateId(
										"CALLS",
										`${effectiveCall.sourceId}:${effectiveCall.calledName}->${targetFileId}`,
									),
									sourceId: effectiveCall.sourceId,
									targetId: targetFileId,
									type: "CALLS",
									confidence: 0.9,
									reason: "vue-template-component",
								});
							}
							break;
						}
					}
				}
				continue;
			}

			const relId = generateId(
				"CALLS",
				`${effectiveCall.sourceId}:${effectiveCall.calledName}->${resolved.nodeId}`,
			);
			graph.addRelationship({
				id: relId,
				sourceId: effectiveCall.sourceId,
				targetId: resolved.nodeId,
				type: "CALLS",
				confidence: resolved.confidence,
				reason: resolved.reason,
			});

			if (
				heritageMap &&
				effectiveCall.callForm === "member" &&
				effectiveCall.receiverTypeName
			) {
				const implTargets = findInterfaceDispatchTargets(
					effectiveCall.calledName,
					effectiveCall.receiverTypeName,
					effectiveCall.filePath,
					ctx,
					heritageMap,
					resolved.nodeId,
				);
				for (const impl of implTargets) {
					graph.addRelationship({
						id: generateId(
							"CALLS",
							`${effectiveCall.sourceId}:${effectiveCall.calledName}->${impl.nodeId}`,
						),
						sourceId: effectiveCall.sourceId,
						targetId: impl.nodeId,
						type: "CALLS",
						confidence: impl.confidence,
						reason: impl.reason,
					});
				}
			}
		}

		ctx.clearCache();
	}

	onProgress?.(totalFiles, totalFiles);
};

/**
 * Resolve pre-extracted field write assignments to ACCESSES {reason: 'write'} edges.
 * Accepts optional constructorBindings for return-type-aware receiver inference,
 * mirroring processCallsFromExtracted's verified binding lookup.
 */
export const processAssignmentsFromExtracted = (
	graph: KnowledgeGraph,
	assignments: ExtractedAssignment[],
	ctx: ResolutionContext,
	constructorBindings?: FileConstructorBindings[],
	bindingAccumulator?: BindingAccumulator,
): void => {
	// Build per-file receiver type indexes from verified constructor bindings
	const fileReceiverTypes = new Map<string, ReceiverTypeIndex>();
	if (constructorBindings) {
		for (const { filePath, bindings } of constructorBindings) {
			const verified = verifyConstructorBindings(
				bindings,
				filePath,
				ctx,
				graph,
				bindingAccumulator,
			);
			if (verified.size > 0) {
				fileReceiverTypes.set(filePath, buildReceiverTypeIndex(verified));
			}
		}
	}

	for (const asn of assignments) {
		// Resolve the receiver type
		let receiverTypeName = asn.receiverTypeName;
		// Tier 2: verified constructor bindings (return-type inference)
		if (!receiverTypeName && fileReceiverTypes.size > 0) {
			const receiverMap = fileReceiverTypes.get(asn.filePath);
			if (receiverMap) {
				const funcName = extractFuncNameFromSourceId(asn.sourceId);
				receiverTypeName = lookupReceiverType(
					receiverMap,
					funcName,
					asn.receiverText,
				);
			}
		}
		// Tier 3: static class-as-receiver fallback
		if (!receiverTypeName) {
			const resolved = ctx.resolve(asn.receiverText, asn.filePath);
			if (resolved?.candidates.some((d) => CLASS_LIKE_TYPES.has(d.type))) {
				receiverTypeName = asn.receiverText;
			}
		}
		if (!receiverTypeName) continue;
		const fieldOwner = resolveFieldOwnership(
			receiverTypeName,
			asn.propertyName,
			asn.filePath,
			ctx,
		);
		if (!fieldOwner) continue;
		graph.addRelationship({
			id: generateId(
				"ACCESSES",
				`${asn.sourceId}:${fieldOwner.nodeId}:write${asn.line !== undefined ? `:${asn.line}` : ""}`,
			),
			sourceId: asn.sourceId,
			targetId: fieldOwner.nodeId,
			type: "ACCESSES",
			confidence: 1.0,
			reason: "write",
		});
	}
};

/**
 * Resolve pre-extracted Laravel routes to CALLS edges from route files to controller methods.
 */
export const processRoutesFromExtracted = async (
	graph: KnowledgeGraph,
	extractedRoutes: ExtractedRoute[],
	ctx: ResolutionContext,
	onProgress?: (current: number, total: number) => void,
) => {
	for (let i = 0; i < extractedRoutes.length; i++) {
		const route = extractedRoutes[i];
		if (i % 50 === 0) {
			onProgress?.(i, extractedRoutes.length);
			await yieldToEventLoop();
		}

		if (!route.controllerName || !route.methodName) continue;

		const controllerResolved = ctx.resolve(route.controllerName, route.filePath);
		if (!controllerResolved || controllerResolved.candidates.length === 0)
			continue;
		if (
			controllerResolved.tier === "global" &&
			controllerResolved.candidates.length > 1
		)
			continue;

		const controllerDef = controllerResolved.candidates[0];
		const confidence = TIER_CONFIDENCE[controllerResolved.tier];

		const methodResolved = ctx.resolve(route.methodName, controllerDef.filePath);
		const methodId =
			methodResolved?.tier === "same-file"
				? methodResolved.candidates[0]?.nodeId
				: undefined;
		const sourceId = generateId("File", route.filePath);

		if (!methodId) {
			const guessedId = generateId(
				"Method",
				`${controllerDef.filePath}:${route.methodName}`,
			);
			const relId = generateId("CALLS", `${sourceId}:route->${guessedId}`);
			graph.addRelationship({
				id: relId,
				sourceId,
				targetId: guessedId,
				type: "CALLS",
				confidence: confidence * 0.8,
				reason: "laravel-route",
			});
			continue;
		}

		const relId = generateId("CALLS", `${sourceId}:route->${methodId}`);
		graph.addRelationship({
			id: relId,
			sourceId,
			targetId: methodId,
			type: "CALLS",
			confidence,
			reason: "laravel-route",
		});
	}

	onProgress?.(extractedRoutes.length, extractedRoutes.length);
};

/**
 * Extract property access keys from a consumer file's source code near fetch calls.
 *
 * Looks for three patterns after a fetch/response variable assignment:
 * 1. Destructuring: `const { data, pagination } = await res.json()`
 * 2. Property access: `response.data`, `result.items`
 * 3. Optional chaining: `data?.key1?.key2`
 *
 * Returns deduplicated top-level property names accessed on the response.
 *
 * NOTE: This scans the entire file content, not just code near a specific fetch call.
 * If a file has multiple fetch calls to different routes, all accessed keys are
 * attributed to each fetch. This is an acceptable tradeoff for regex-based extraction.
 */

/** Common method names on response/data objects that are NOT property accesses */
// Properties/methods to ignore when extracting consumer accessed keys from `data.X` patterns.
// Avoids false positives from Fetch API, Array, Object, Promise, and DOM access on variables
// that happen to share names with response variables (data, result, response, etc.).
const RESPONSE_ACCESS_BLOCKLIST = new Set([
	// Fetch/Response API
	"json",
	"text",
	"blob",
	"arrayBuffer",
	"formData",
	"ok",
	"status",
	"headers",
	"clone",
	// Promise
	"then",
	"catch",
	"finally",
	// Array
	"map",
	"filter",
	"forEach",
	"reduce",
	"find",
	"some",
	"every",
	"push",
	"pop",
	"shift",
	"unshift",
	"splice",
	"slice",
	"concat",
	"join",
	"sort",
	"reverse",
	"includes",
	"indexOf",
	// Object
	"length",
	"toString",
	"valueOf",
	"keys",
	"values",
	"entries",
	// DOM methods — file-download patterns often reuse `data`/`response` variable names
	"appendChild",
	"removeChild",
	"insertBefore",
	"replaceChild",
	"replaceChildren",
	"createElement",
	"getElementById",
	"querySelector",
	"querySelectorAll",
	"setAttribute",
	"getAttribute",
	"removeAttribute",
	"hasAttribute",
	"addEventListener",
	"removeEventListener",
	"dispatchEvent",
	"classList",
	"className",
	"parentNode",
	"parentElement",
	"childNodes",
	"children",
	"nextSibling",
	"previousSibling",
	"firstChild",
	"lastChild",
	"click",
	"focus",
	"blur",
	"submit",
	"reset",
	"innerHTML",
	"outerHTML",
	"textContent",
	"innerText",
]);

export const extractConsumerAccessedKeys = (content: string): string[] => {
	const keys = new Set<string>();

	// Pattern 1: Destructuring from .json() — const { key1, key2 } = await res.json()
	// Also matches: const { key1, key2 } = await (await fetch(...)).json()
	const destructurePattern =
		/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:await\s+)?(?:\w+\.json\s*\(\)|(?:await\s+)?(?:fetch|axios|got)\s*\([^)]*\)(?:\.then\s*\([^)]*\))?(?:\.json\s*\(\))?)/g;
	let match;
	while ((match = destructurePattern.exec(content)) !== null) {
		const destructuredBody = match[1];
		// Extract identifiers from destructuring, handling renamed bindings (key: alias)
		const keyPattern = /(\w+)\s*(?::\s*\w+)?/g;
		let keyMatch;
		while ((keyMatch = keyPattern.exec(destructuredBody)) !== null) {
			keys.add(keyMatch[1]);
		}
	}

	// Pattern 2: Destructuring from a data/result/response/json variable
	// e.g., const { items, total } = data; or const { error } = result;
	const dataVarDestructure =
		/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:data|result|response|json|body|res)\b/g;
	while ((match = dataVarDestructure.exec(content)) !== null) {
		const destructuredBody = match[1];
		const keyPattern = /(\w+)\s*(?::\s*\w+)?/g;
		let keyMatch;
		while ((keyMatch = keyPattern.exec(destructuredBody)) !== null) {
			keys.add(keyMatch[1]);
		}
	}

	// Pattern 3: Property access on common response variable names
	// Matches: data.key, response.key, result.key, json.key, body.key
	// Also matches optional chaining: data?.key
	const propAccessPattern =
		/\b(?:data|response|result|json|body|res)\s*(?:\?\.|\.)(\w+)/g;
	while ((match = propAccessPattern.exec(content)) !== null) {
		const key = match[1];
		// Skip common method calls that aren't property accesses
		if (!RESPONSE_ACCESS_BLOCKLIST.has(key)) {
			keys.add(key);
		}
	}

	return [...keys];
};

/**
 * Create FETCHES edges from extracted fetch() calls to matching Route nodes.
 * When consumerContents is provided, extracts property access patterns from
 * consumer files and encodes them in the edge reason field.
 */
export const processNextjsFetchRoutes = (
	graph: KnowledgeGraph,
	fetchCalls: ExtractedFetchCall[],
	routeRegistry: Map<string, string>, // routeURL → handlerFilePath
	consumerContents?: Map<string, string>, // filePath → file content
) => {
	// Pre-count how many routes each consumer file matches (for confidence attribution)
	const routeCountByFile = new Map<string, number>();
	for (const call of fetchCalls) {
		const normalized = normalizeFetchURL(call.fetchURL);
		if (!normalized) continue;
		for (const [routeURL] of routeRegistry) {
			if (routeMatches(normalized, routeURL)) {
				routeCountByFile.set(
					call.filePath,
					(routeCountByFile.get(call.filePath) ?? 0) + 1,
				);
				break;
			}
		}
	}

	for (const call of fetchCalls) {
		const normalized = normalizeFetchURL(call.fetchURL);
		if (!normalized) continue;

		for (const [routeURL] of routeRegistry) {
			if (routeMatches(normalized, routeURL)) {
				const sourceId = generateId("File", call.filePath);
				const routeNodeId = generateId("Route", routeURL);

				// Extract consumer accessed keys if file content is available
				let reason = "fetch-url-match";
				if (consumerContents) {
					const content = consumerContents.get(call.filePath);
					if (content) {
						const accessedKeys = extractConsumerAccessedKeys(content);
						if (accessedKeys.length > 0) {
							reason = `fetch-url-match|keys:${accessedKeys.join(",")}`;
						}
					}
				}

				// Encode multi-fetch count so downstream can set confidence
				const fetchCount = routeCountByFile.get(call.filePath) ?? 1;
				if (fetchCount > 1) {
					reason = `${reason}|fetches:${fetchCount}`;
				}

				graph.addRelationship({
					id: generateId("FETCHES", `${sourceId}->${routeNodeId}`),
					sourceId,
					targetId: routeNodeId,
					type: "FETCHES",
					confidence: 0.9,
					reason,
				});
				break;
			}
		}
	}
};

/**
 * Extract fetch() calls from source files (sequential path).
 * Workers handle this via tree-sitter captures in parse-worker; this function
 * provides the same extraction for the sequential fallback path.
 */
export const extractFetchCallsFromFiles = async (
	files: { path: string; content: string }[],
	astCache: ASTCache,
): Promise<ExtractedFetchCall[]> => {
	const parser = await loadParser();
	const result: ExtractedFetchCall[] = [];

	for (const file of files) {
		const language = getLanguageFromFilename(file.path);
		if (!language) continue;
		if (!isLanguageAvailable(language)) continue;

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
			} catch {
				continue;
			}
			astCache.set(file.path, tree);
		}

		let matches;
		try {
			const lang = parser.getLanguage();
			const query = new Parser.Query(lang, queryStr);
			matches = query.matches(tree.rootNode);
		} catch {
			continue;
		}

		for (const match of matches) {
			const captureMap: Record<string, any> = {};
			match.captures.forEach((c) => (captureMap[c.name] = c.node));

			if (captureMap["route.fetch"]) {
				const urlNode = captureMap["route.url"] ?? captureMap["route.template_url"];
				if (urlNode) {
					result.push({
						filePath: file.path,
						fetchURL: urlNode.text,
						lineNumber: captureMap["route.fetch"].startPosition.row,
					});
				}
			} else if (captureMap.http_client && captureMap["http_client.url"]) {
				const method = captureMap["http_client.method"]?.text;
				const url = captureMap["http_client.url"].text;
				const HTTP_CLIENT_ONLY = new Set(["head", "options", "request", "ajax"]);
				if (method && HTTP_CLIENT_ONLY.has(method) && url.startsWith("/")) {
					result.push({
						filePath: file.path,
						fetchURL: url,
						lineNumber: captureMap.http_client.startPosition.row,
					});
				}
			}
		}
	}

	return result;
};
