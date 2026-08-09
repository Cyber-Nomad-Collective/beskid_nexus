import type {
	GraphNode,
	GraphRelationship,
	NodeLabel,
} from "gitnexus-shared";
import {
	getLanguageFromFilename,
	SupportedLanguages,
} from "gitnexus-shared";
import Parser from "tree-sitter";
import { generateId } from "../../../lib/utils.js";
import type { KnowledgeGraph } from "../../graph/types.js";
import { logger } from "../../logger.js";
import {
	isLanguageAvailable,
	loadLanguage,
	loadParser,
} from "../../tree-sitter/parser-loader.js";
import { parseSourceSafe } from "../../tree-sitter/safe-parse.js";
import type { ASTCache } from "../ast-cache.js";
import {
	getTreeSitterBufferSize,
	getTreeSitterContentByteLength,
	TREE_SITTER_MAX_BUFFER,
} from "../constants.js";
import { detectFrameworkFromAST } from "../framework-detection.js";
import { getProvider } from "../languages/index.js";
import type { MethodInfo } from "../method-types.js";
import type { SymbolTableWriter } from "../model/index.js";
import { buildTypeEnv } from "../type-env.js";
import {
	getDefinitionNodeFromCaptures,
	getLabelFromCaptures,
	type SyntaxNode,
} from "../utils/ast-helpers.js";
import { yieldToEventLoop } from "../utils/event-loop.js";
import {
	arityForIdFromInfo,
	buildCollisionGroups,
	buildMethodProps,
	constTagForId,
	typeTagForId,
} from "../utils/method-props.js";
import {
	extractTemplateArguments,
	templateArgumentsIdTag,
} from "../utils/template-arguments.js";
import { isVerboseIngestionEnabled } from "../utils/verbose.js";
import {
	extractVueScript,
	isVueSetupTopLevel,
} from "../vue-sfc-extractor.js";
import type { FileProgressCallback } from "./contracts.js";
import {
	cachedExportCheck,
	cachedFindEnclosingClassInfo,
	classInfoCache,
	exportCache,
	NOOP_SYMBOL_TABLE_SEQ,
	seqFieldInfoCache,
	seqFindEnclosingOwnerNode,
	seqGetFieldInfo,
	seqMethodExtractCache,
	seqMethodMapCache,
} from "./sequential-context.js";

export const processParsingSequential = async (
	graph: KnowledgeGraph,
	files: { path: string; content: string }[],
	symbolTable: SymbolTableWriter,
	astCache: ASTCache,
	scopeTreeCache: ASTCache | undefined,
	onFileProgress?: FileProgressCallback,
) => {
	const parser = await loadParser();
	const total = files.length;
	const logSkipped = isVerboseIngestionEnabled();
	const skippedByLang = logSkipped ? new Map<string, number>() : null;

	for (let i = 0; i < files.length; i++) {
		const file = files[i];

		// Reset memoization before each new file (node refs are per-tree)
		classInfoCache.clear();
		exportCache.clear();
		seqFieldInfoCache.clear();
		seqMethodExtractCache.clear();
		seqMethodMapCache.clear();

		onFileProgress?.(i + 1, total, file.path);

		if (i % 20 === 0) await yieldToEventLoop();

		const language = getLanguageFromFilename(file.path);

		if (!language) continue;
		if (!isLanguageAvailable(language)) {
			if (skippedByLang) {
				skippedByLang.set(language, (skippedByLang.get(language) ?? 0) + 1);
			}
			continue;
		}

		// Skip files larger than the max tree-sitter buffer (32 MB)
		if (getTreeSitterContentByteLength(file.content) > TREE_SITTER_MAX_BUFFER)
			continue;

		// Vue SFC preprocessing: extract <script> block content
		let parseContent = file.content;
		let lineOffset = 0;
		let isVueSetup = false;
		if (language === SupportedLanguages.Vue) {
			const extracted = extractVueScript(file.content);
			if (!extracted) continue; // skip .vue files with no script block
			parseContent = extracted.scriptContent;
			lineOffset = extracted.lineOffset;
			isVueSetup = extracted.isSetup;
		}

		// Per-language source-text transform (e.g., UE macro stripping for C++).
		// Length-preserving — see LanguageProvider.preprocessSource contract.
		parseContent =
			getProvider(language).preprocessSource?.(parseContent, file.path) ??
			parseContent;

		try {
			await loadLanguage(language, file.path);
		} catch {
			continue; // parser unavailable — safety net
		}

		let tree: Parser.Tree;
		try {
			tree = parseSourceSafe(parser, parseContent, undefined, {
				bufferSize: getTreeSitterBufferSize(parseContent),
			});
		} catch (_parseError) {
			logger.warn(`Skipping unparseable file: ${file.path}`);
			continue;
		}

		astCache.set(file.path, tree);

		const provider = getProvider(language);
		// Mirror into the cross-phase cache only when the language has a
		// scope-resolution consumer — otherwise we retain Trees no one
		// reads. parse-impl clears `astCache` between chunks;
		// `scopeTreeCache` survives until scope-resolution disposes it.
		if (provider.emitScopeCaptures !== undefined) {
			scopeTreeCache?.set(file.path, tree);
		}
		const queryString = provider.treeSitterQueries;
		if (!queryString) {
			continue;
		}

		let query: Parser.Query;
		let matches: Parser.QueryMatch[];
		try {
			const language = parser.getLanguage();
			query = new Parser.Query(language, queryString);
			matches = query.matches(tree.rootNode);
		} catch (queryError) {
			logger.warn({ queryError }, `Query error for ${file.path}:`);
			continue;
		}

		// Build per-file type environment for FieldExtractor context (lightweight — skipped if no fieldExtractor).
		//
		// Note: this TypeEnv is intentionally NOT flushed into the BindingAccumulator.
		// The accumulator feed happens later in `call-processor.ts` via its own
		// `typeEnv.flush(accumulator)` call. Flushing here would double-count
		// file-scope bindings and break the single-use invariant of `flush()`.
		// See the BindingAccumulator class JSDoc for the full accumulator
		// lifecycle and flush-site ownership rules.
		const typeEnv = provider.fieldExtractor
			? buildTypeEnv(tree, language, {
					enclosingFunctionFinder: provider.enclosingFunctionFinder,
					extractFunctionName: provider.methodExtractor?.extractFunctionName,
				})
			: null;

		matches.forEach((match) => {
			const captureMap: Record<string, SyntaxNode> = {};

			match.captures.forEach((c) => {
				captureMap[c.name] = c.node;
			});

			const definitionNodeForRange = getDefinitionNodeFromCaptures(captureMap);
			const definitionNode = getDefinitionNodeFromCaptures(captureMap);
			const defaultNodeLabel = getLabelFromCaptures(captureMap, provider);
			if (!defaultNodeLabel) return;

			const nameNode = captureMap.name;
			const extractedClassSymbol =
				definitionNode && provider.classExtractor?.isTypeDeclaration(definitionNode)
					? provider.classExtractor.extract(definitionNode, {
							name: nameNode?.text,
							type: defaultNodeLabel,
						})
					: null;
			const nodeLabel = extractedClassSymbol?.type ?? defaultNodeLabel;
			const isClassLikeLabel =
				nodeLabel === "Class" ||
				nodeLabel === "Struct" ||
				nodeLabel === "Interface" ||
				nodeLabel === "Enum" ||
				nodeLabel === "Record";
			if (
				isClassLikeLabel &&
				provider.classExtractor?.shouldSkipClassCapture?.({
					captureMap,
					definitionNode,
					nameNode,
					nodeLabel,
				}) === true
			) {
				return;
			}
			// Synthesize name for constructors without explicit @name capture (e.g. Swift init)
			if (!nameNode && nodeLabel !== "Constructor" && !extractedClassSymbol)
				return;
			const nodeName =
				extractedClassSymbol?.name ?? (nameNode ? nameNode.text : "init");

			const startLine = definitionNodeForRange
				? definitionNodeForRange.startPosition.row + lineOffset
				: nameNode
					? nameNode.startPosition.row + lineOffset
					: lineOffset;

			// Compute enclosing class BEFORE node ID — needed to qualify method IDs
			const needsOwner =
				nodeLabel === "Method" ||
				nodeLabel === "Constructor" ||
				nodeLabel === "Property" ||
				nodeLabel === "Function";
			const enclosingClassInfo = needsOwner
				? cachedFindEnclosingClassInfo(
						nameNode || definitionNodeForRange,
						file.path,
						provider.resolveEnclosingOwner,
					)
				: null;
			const enclosingClassId = enclosingClassInfo?.classId ?? null;

			// Qualify method/property IDs with enclosing class name to avoid collisions
			// e.g. "Method:animal.dart:Animal.speak" vs "Method:animal.dart:Dog.speak"
			const qualifiedName = enclosingClassInfo
				? `${enclosingClassInfo.className}.${nodeName}`
				: nodeName;

			// Extract method metadata for Function/Method/Constructor nodes BEFORE generating
			// the node ID — parameterCount is needed to disambiguate overloaded methods.
			// Use the per-language MethodExtractor for method metadata (isAbstract, isStatic,
			// visibility, annotations, parameterCount, parameterTypes, returnType, etc.).
			const isMethodLike =
				nodeLabel === "Function" ||
				nodeLabel === "Method" ||
				nodeLabel === "Constructor";
			let methodProps: Record<string, unknown> = {};
			let arityForId: number | undefined; // raw param count for ID, even for variadic
			let seqDefMethodInfo: MethodInfo | undefined;
			let seqDefMethods: MethodInfo[] | undefined;
			let seqClassNodeId: number | undefined;
			if (isMethodLike && definitionNode) {
				let enriched = false;

				if (provider.methodExtractor) {
					// Try class-based extraction (method inside a class/struct/trait body).
					// Raw lookup (no resolveEnclosingOwner) so the method extractor sees
					// the actual container node (e.g. singleton_class) for static detection.
					const methodOwnerNode = seqFindEnclosingOwnerNode(definitionNode);
					if (methodOwnerNode) {
						// Cache extract() results per class node to avoid re-traversing the
						// same class body for every method it contains (O(N) -> O(1) per hit).
						let result:
							| { ownerName: string | undefined; methods: MethodInfo[] }
							| null
							| undefined = seqMethodExtractCache.get(methodOwnerNode.id);
						if (result === undefined) {
							result =
								provider.methodExtractor.extract(methodOwnerNode, {
									filePath: file.path,
									language,
								}) ?? null;
							seqMethodExtractCache.set(methodOwnerNode.id, result);
						}
						if (result?.methods?.length) {
							const defLine = definitionNode.startPosition.row + 1;
							const info = result.methods.find(
								(m) => m.name === nodeName && m.line === defLine,
							);
							if (info) {
								enriched = true;
								arityForId = arityForIdFromInfo(info);
								methodProps = buildMethodProps(info);
								seqDefMethodInfo = info;
								seqDefMethods = result.methods;
								seqClassNodeId = methodOwnerNode.id;
							}
						}
					}

					// For top-level methods (e.g. Go method_declaration), try extractFromNode
					if (!enriched && provider.methodExtractor.extractFromNode) {
						const info = provider.methodExtractor.extractFromNode(definitionNode, {
							filePath: file.path,
							language,
						});
						if (info) {
							enriched = true;
							arityForId = arityForIdFromInfo(info);
							methodProps = buildMethodProps(info);
						}
					}
				}
			}

			// Append #<paramCount> to owned callable IDs to disambiguate overloads.
			// Top-level Function IDs stay stable; functions inside an owner may overload.
			// When same-arity collisions exist, append ~type1,type2 for further disambiguation.
			const needsAritySuffix =
				nodeLabel === "Method" ||
				nodeLabel === "Constructor" ||
				(nodeLabel === "Function" && enclosingClassId !== null);
			let arityTag =
				needsAritySuffix && arityForId !== undefined ? `#${arityForId}` : "";
			if (
				arityTag &&
				seqDefMethods &&
				seqDefMethodInfo &&
				seqClassNodeId !== undefined
			) {
				// Use cached method map + collision groups (built once per class, not per method)
				let cached = seqMethodMapCache.get(seqClassNodeId);
				if (!cached) {
					const tempMap = new Map<string, MethodInfo>();
					for (const m of seqDefMethods) tempMap.set(`${m.name}:${m.line}`, m);
					cached = { map: tempMap, groups: buildCollisionGroups(tempMap) };
					seqMethodMapCache.set(seqClassNodeId, cached);
				}
				arityTag += typeTagForId(
					cached.map,
					nodeName,
					arityForId,
					seqDefMethodInfo,
					language,
					cached.groups,
				);
				arityTag += constTagForId(
					cached.map,
					nodeName,
					arityForId,
					seqDefMethodInfo,
					cached.groups,
				);
			}
			const classTemplateArguments =
				extractedClassSymbol?.templateArguments ??
				provider.classExtractor?.extractTemplateArgumentsFromCapture?.({
					captureMap,
					definitionNode,
					nameNode,
				}) ??
				(captureMap["template-arguments"]
					? extractTemplateArguments(captureMap["template-arguments"].text)
					: undefined) ??
				(nameNode?.text ? extractTemplateArguments(nameNode.text) : undefined);
			const classTemplateTag =
				(nodeLabel === "Class" ||
					nodeLabel === "Struct" ||
					nodeLabel === "Interface" ||
					nodeLabel === "Enum" ||
					nodeLabel === "Record") &&
				classTemplateArguments !== undefined &&
				classTemplateArguments.length > 0
					? templateArgumentsIdTag(classTemplateArguments)
					: "";
			const nodeId = generateId(
				nodeLabel,
				`${file.path}:${qualifiedName}${classTemplateTag}${arityTag}`,
			);
			const classNodeForSymbol =
				definitionNodeForRange || definitionNode || nameNode;
			const qualifiedTypeName =
				extractedClassSymbol?.qualifiedName ??
				(classNodeForSymbol &&
				provider.classExtractor?.isTypeDeclaration(classNodeForSymbol)
					? (provider.classExtractor.extractQualifiedName(
							classNodeForSymbol,
							nodeName,
						) ?? nodeName)
					: undefined);
			const frameworkHint = definitionNode
				? detectFrameworkFromAST(
						language,
						(definitionNode.text || "").slice(0, 300),
					)
				: null;

			const node: GraphNode = {
				id: nodeId,
				label: nodeLabel as NodeLabel,
				properties: {
					name: nodeName,
					filePath: file.path,
					startLine: definitionNodeForRange
						? definitionNodeForRange.startPosition.row + lineOffset
						: startLine,
					endLine: definitionNodeForRange
						? definitionNodeForRange.endPosition.row + lineOffset
						: startLine,
					language: language,
					isExported:
						language === SupportedLanguages.Vue && isVueSetup
							? isVueSetupTopLevel(nameNode || definitionNodeForRange)
							: cachedExportCheck(
									provider.exportChecker,
									nameNode || definitionNodeForRange,
									nodeName,
								),
					...(qualifiedTypeName !== undefined
						? { qualifiedName: qualifiedTypeName }
						: {}),
					...(classTemplateArguments !== undefined &&
					classTemplateArguments.length > 0
						? { templateArguments: classTemplateArguments }
						: {}),
					...(frameworkHint
						? {
								astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
								astFrameworkReason: frameworkHint.reason,
							}
						: {}),
					...methodProps,
				},
			};

			graph.addNode(node);

			// enclosingClassId already computed above (before nodeId generation)

			// Extract declared type and field metadata for Property nodes
			let declaredType: string | undefined;
			let seqVisibility: string | undefined;
			let seqIsStatic: boolean | undefined;
			let seqIsReadonly: boolean | undefined;
			if (nodeLabel === "Property" && definitionNode) {
				// FieldExtractor is the single source of truth when available
				if (provider.fieldExtractor && typeEnv) {
					const classNode = seqFindEnclosingOwnerNode(
						definitionNode,
						provider.resolveEnclosingOwner,
					);
					if (classNode) {
						const fieldMap = seqGetFieldInfo(classNode, provider, {
							typeEnv,
							symbolTable: NOOP_SYMBOL_TABLE_SEQ,
							filePath: file.path,
							language,
						});
						const info = fieldMap?.get(nodeName);
						if (info) {
							declaredType = info.type ?? undefined;
							seqVisibility = info.visibility;
							seqIsStatic = info.isStatic;
							seqIsReadonly = info.isReadonly;
						}
					}
				}
				// All 15 tree-sitter languages register a FieldExtractor — no fallback needed.
			}

			// Apply field metadata to the graph node retroactively
			if (seqVisibility !== undefined) node.properties.visibility = seqVisibility;
			if (seqIsStatic !== undefined) node.properties.isStatic = seqIsStatic;
			if (seqIsReadonly !== undefined) node.properties.isReadonly = seqIsReadonly;
			if (declaredType !== undefined) node.properties.declaredType = declaredType;

			symbolTable.add(file.path, nodeName, nodeId, nodeLabel, {
				parameterCount: methodProps.parameterCount as number | undefined,
				requiredParameterCount: methodProps.requiredParameterCount as
					| number
					| undefined,
				parameterTypes: methodProps.parameterTypes as string[] | undefined,
				returnType: methodProps.returnType as string | undefined,
				declaredType,
				templateArguments: classTemplateArguments,
				ownerId: enclosingClassId ?? undefined,
				qualifiedName: qualifiedTypeName,
			});

			const fileId = generateId("File", file.path);

			const relId = generateId("DEFINES", `${fileId}->${nodeId}`);

			const relationship: GraphRelationship = {
				id: relId,
				sourceId: fileId,
				targetId: nodeId,
				type: "DEFINES",
				confidence: 1.0,
				reason: "",
			};

			graph.addRelationship(relationship);

			// ── HAS_METHOD / HAS_PROPERTY: link member to enclosing class ──
			if (enclosingClassId) {
				const memberEdgeType =
					nodeLabel === "Property" ? "HAS_PROPERTY" : "HAS_METHOD";
				graph.addRelationship({
					id: generateId(memberEdgeType, `${enclosingClassId}->${nodeId}`),
					sourceId: enclosingClassId,
					targetId: nodeId,
					type: memberEdgeType,
					confidence: 1.0,
					reason: "",
				});
			}
		});
	}

	if (skippedByLang && skippedByLang.size > 0) {
		for (const [lang, count] of skippedByLang.entries()) {
			logger.warn(
				`[ingestion] Skipped ${count} ${lang} file(s) in parsing processing — ${lang} parser not available.`,
			);
		}
	}
};
