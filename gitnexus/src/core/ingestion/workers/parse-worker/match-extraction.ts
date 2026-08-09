import { SupportedLanguages } from "gitnexus-shared";
import type Parser from "tree-sitter";
import type { LanguageProvider } from "../../language-provider.js";
import { detectFrameworkFromAST } from "../../framework-detection.js";
import { preprocessImportPath } from "../../import-processor.js";
import type { TypeEnvironment } from "../../type-env.js";
import type { MethodInfo } from "../../method-types.js";
import {
	getDefinitionNodeFromCaptures,
	getLabelFromCaptures,
	type SyntaxNode,
} from "../../utils/ast-helpers.js";
import {
	arityForIdFromInfo,
	buildCollisionGroups,
	buildMethodProps,
	constTagForId,
	typeTagForId,
} from "../../utils/method-props.js";
import {
	extractTemplateArguments,
	templateArgumentsIdTag,
} from "../../utils/template-arguments.js";
import type { VariableExtractorContext } from "../../variable-types.js";
import { isVueSetupTopLevel } from "../../vue-sfc-extractor.js";
import { generateId } from "../../../../lib/utils.js";
import { extractCallCapture } from "./call-extraction.js";
import {
	cachedExportCheck,
	cachedFindEnclosingClassInfo,
	findClassNodeByQualifiedName,
	findEnclosingClassNode,
	findEnclosingFunctionId,
	getFieldInfo,
	getMethodInfo,
	NOOP_SYMBOL_TABLE,
} from "./extraction-context.js";
import type { ParseWorkerInput, ParseWorkerResult } from "./protocol.js";
import {
	EXPRESS_ROUTE_METHODS,
	HTTP_CLIENT_ONLY_METHODS,
	HTTP_CLIENT_RECEIVERS,
	ROUTE_DECORATOR_NAMES,
} from "./routes.js";

interface MatchExtractionContext {
	matches: Parser.QueryMatch[];
	file: ParseWorkerInput;
	language: SupportedLanguages;
	provider: LanguageProvider;
	typeEnv: TypeEnvironment;
	callRouter: LanguageProvider["callRouter"];
	lineOffset: number;
	isVueSetup: boolean;
	result: ParseWorkerResult;
}

export const extractMatches = ({
	matches,
	file,
	language,
	provider,
	typeEnv,
	callRouter,
	lineOffset,
	isVueSetup,
	result,
}: MatchExtractionContext): void => {
	// Per-file map: decorator end-line → decorator info, for associating with definitions
	const fileDecorators = new Map<
		number,
		{ name: string; arg?: string; isTool?: boolean }
	>();

	// Track start indices of definition nodes already processed by higher-priority captures
	// (e.g. @definition.function) to avoid duplicate nodes when @definition.const/@definition.variable
	// patterns overlap with the same source range.
	const processedDefinitionNodes = new Set<number>();

	for (const match of matches) {
		const captureMap: Record<string, SyntaxNode> = {};
		for (const c of match.captures) {
			captureMap[c.name] = c.node;
		}

		// Extract import paths before skipping
		if (captureMap.import && captureMap["import.source"]) {
			const rawImportPath = preprocessImportPath(
				captureMap["import.source"].text,
				captureMap.import,
				provider,
			);
			if (!rawImportPath) continue;
			const extractor = provider.namedBindingExtractor;
			const namedBindings = extractor ? extractor(captureMap.import) : undefined;
			result.imports.push({
				filePath: file.path,
				rawImportPath,
				language: language,
				...(namedBindings ? { namedBindings } : {}),
			});
			continue;
		}

		// Extract assignment sites (field write access)
		if (
			captureMap.assignment &&
			captureMap["assignment.receiver"] &&
			captureMap["assignment.property"]
		) {
			const receiverText = captureMap["assignment.receiver"].text;
			const propertyName = captureMap["assignment.property"].text;
			if (receiverText && propertyName) {
				const srcId =
					findEnclosingFunctionId(captureMap.assignment, file.path, provider) ||
					generateId("File", file.path);
				let receiverTypeName: string | undefined;
				if (typeEnv) {
					receiverTypeName =
						typeEnv.lookup(receiverText, captureMap.assignment) ?? undefined;
				}
				result.assignments.push({
					filePath: file.path,
					sourceId: srcId,
					receiverText,
					propertyName,
					line: captureMap.assignment.startPosition.row + 1,
					...(receiverTypeName ? { receiverTypeName } : {}),
				});
			}
			if (!captureMap.call) continue;
		}

		// Store decorator metadata for later association with definitions
		if (captureMap.decorator && captureMap["decorator.name"]) {
			const decoratorName = captureMap["decorator.name"].text;
			const decoratorArg = captureMap["decorator.arg"]?.text;
			const decoratorNode = captureMap.decorator;
			// Store by the decorator's end line — the definition follows immediately after
			fileDecorators.set(decoratorNode.endPosition.row, {
				name: decoratorName,
				arg: decoratorArg,
			});

			if (ROUTE_DECORATOR_NAMES.has(decoratorName)) {
				const routePath = decoratorArg || "";
				const method = decoratorName.replace("Mapping", "").toUpperCase();
				const httpMethod = ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(
					method,
				)
					? method
					: "GET";
				result.decoratorRoutes.push({
					filePath: file.path,
					routePath,
					httpMethod,
					decoratorName,
					lineNumber: decoratorNode.startPosition.row + lineOffset,
				});
			}
			// MCP/RPC tool detection: @mcp.tool(), @app.tool(), @server.tool()
			if (decoratorName === "tool") {
				// Re-store with isTool flag for the definition handler
				fileDecorators.set(decoratorNode.endPosition.row, {
					name: decoratorName,
					arg: decoratorArg,
					isTool: true,
				});
			}
			continue;
		}

		// Extract HTTP consumer URLs: fetch(), axios.get(), $.get(), requests.get(), etc.
		if (captureMap["route.fetch"]) {
			const urlNode = captureMap["route.url"] ?? captureMap["route.template_url"];
			if (urlNode) {
				result.fetchCalls.push({
					filePath: file.path,
					fetchURL: urlNode.text,
					lineNumber: captureMap["route.fetch"].startPosition.row + lineOffset,
				});
			}
			continue;
		}

		// HTTP client calls: axios.get('/path'), $.post('/path'), requests.get('/path')
		// Skip methods also in EXPRESS_ROUTE_METHODS to avoid double-registering Express
		// routes as both route definitions AND consumers (both queries match same AST node)
		if (captureMap.http_client && captureMap["http_client.url"]) {
			const method = captureMap["http_client.method"]?.text;
			const url = captureMap["http_client.url"].text;
			if (method && HTTP_CLIENT_ONLY_METHODS.has(method) && url.startsWith("/")) {
				result.fetchCalls.push({
					filePath: file.path,
					fetchURL: url,
					lineNumber: captureMap.http_client.startPosition.row + lineOffset,
				});
			}
			continue;
		}

		// Express/Hono route registration: app.get('/path', handler)
		if (
			captureMap.express_route &&
			captureMap["express_route.method"] &&
			captureMap["express_route.path"]
		) {
			const method = captureMap["express_route.method"].text;
			const routePath = captureMap["express_route.path"].text;
			if (EXPRESS_ROUTE_METHODS.has(method) && routePath.startsWith("/")) {
				// Extract the receiver (the object the method is called on) to filter out
				// HTTP client calls like axios.get('/api/users') that match the same pattern
				// as Express route registrations.
				const callNode = captureMap.express_route;
				const funcNode =
					callNode.childForFieldName?.("function") ?? callNode.children?.[0];
				// Walk through nested member_expressions and call_expressions to
				// reach the innermost receiver identifier.  Handles chains like:
				//   this.httpService.get('/path')   -> member chain    -> 'httpservice'
				//   getClient().get('/path')         -> call_expression -> 'getclient'
				//   axios.get('/path')               -> bare identifier -> 'axios'
				let receiverNode =
					funcNode?.childForFieldName?.("object") ?? funcNode?.children?.[0];
				while (
					receiverNode?.type === "member_expression" ||
					receiverNode?.type === "call_expression"
				) {
					if (receiverNode.type === "member_expression") {
						// Drill into the property (rightmost part) of the member expression
						const propNode = receiverNode.childForFieldName?.("property");
						if (propNode) {
							receiverNode = propNode;
						} else {
							break;
						}
					} else {
						// call_expression: unwrap to the function being called
						const innerFunc =
							receiverNode.childForFieldName?.("function") ??
							receiverNode.children?.[0];
						if (innerFunc && innerFunc !== receiverNode) {
							receiverNode = innerFunc;
						} else {
							break;
						}
					}
				}
				const receiverText = receiverNode?.text?.toLowerCase() ?? "";

				if (HTTP_CLIENT_RECEIVERS.has(receiverText)) {
					// This is an HTTP client call, not a route definition u2014 skip it
					continue;
				}

				const httpMethod =
					method === "all" || method === "use" || method === "route"
						? "GET"
						: method.toUpperCase();
				result.decoratorRoutes.push({
					filePath: file.path,
					routePath,
					httpMethod,
					decoratorName: `express.${method}`,
					lineNumber: captureMap.express_route.startPosition.row + lineOffset,
				});
			}
			continue;
		}

		// Extract call sites
		if (captureMap.call) {
		extractCallCapture({
			captureMap,
			file,
			language,
			provider,
			typeEnv,
			callRouter,
			result,
		});
			continue;
		}

		// Extract heritage (extends/implements) via provider heritage extractor
		if (captureMap["heritage.class"]) {
			if (provider.heritageExtractor) {
				const heritageItems = provider.heritageExtractor.extract(captureMap, {
					filePath: file.path,
					language,
				});
				for (const item of heritageItems) {
					result.heritage.push({
						filePath: file.path,
						className: item.className,
						parentName: item.parentName,
						kind: item.kind,
					});
				}
				// When the extractor consumes the match, skip symbol processing below.
				if (heritageItems.length > 0) {
					continue;
				}
			}
			// Fallback: the extractor returned [] (or is absent), but the match still
			// carries a heritage-specific capture. The match belongs to a heritage
			// clause and must not fall through to generic symbol processing.
			if (
				captureMap["heritage.extends"] ||
				captureMap["heritage.implements"] ||
				captureMap["heritage.trait"]
			) {
				continue;
			}
		}

		const definitionNode = getDefinitionNodeFromCaptures(captureMap);
		const defaultNodeLabel = getLabelFromCaptures(captureMap, provider);
		if (!defaultNodeLabel) continue;

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
			continue;
		}

		// Dedup: variable captures (Const/Static/Variable) may overlap with higher-priority
		// captures (e.g. `const fn = () => {}` matches both @definition.function and @definition.const).
		// Skip variable captures whose definition node was already processed.
		if (
			(nodeLabel === "Const" ||
				nodeLabel === "Static" ||
				nodeLabel === "Variable") &&
			definitionNode &&
			processedDefinitionNodes.has(definitionNode.startIndex)
		) {
			continue;
		}
		if (definitionNode) {
			processedDefinitionNodes.add(definitionNode.startIndex);
		}

		// Synthesize name for constructors without explicit @name capture (e.g. Swift init)
		if (!nameNode && nodeLabel !== "Constructor" && !extractedClassSymbol)
			continue;
		const nodeName =
			extractedClassSymbol?.name ?? (nameNode ? nameNode.text : "init");
		const startLine = definitionNode
			? definitionNode.startPosition.row + lineOffset
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
					nameNode || definitionNode,
					file.path,
					provider.resolveEnclosingOwner,
				)
			: null;
		const enclosingClassId = enclosingClassInfo?.classId ?? null;

		// Qualify method/property IDs with enclosing class name to avoid collisions
		const qualifiedName = enclosingClassInfo
			? `${enclosingClassInfo.className}.${nodeName}`
			: nodeName;

		// Extract method metadata BEFORE generating node ID — parameterCount is needed
		// to disambiguate overloaded methods via #<arity> suffix in the ID.
		let declaredType: string | undefined;
		let methodProps: Record<string, unknown> = {};
		let arityForId: number | undefined; // raw param count for ID, even for variadic
		let defMethodMap: Map<string, MethodInfo> | undefined;
		let defMethodInfo: MethodInfo | undefined;
		if (
			nodeLabel === "Function" ||
			nodeLabel === "Method" ||
			nodeLabel === "Constructor"
		) {
			// Use MethodExtractor for method metadata — provides parameterCount, parameterTypes,
			// returnType, isAbstract/isFinal/annotations, visibility, and more.
			let enrichedByMethodExtractor = false;
			if (provider.methodExtractor && definitionNode) {
				const classNode =
					findEnclosingClassNode(definitionNode) ??
					findClassNodeByQualifiedName(definitionNode);
				if (classNode) {
					const methodMap = getMethodInfo(classNode, provider, {
						filePath: file.path,
						language,
					});
					const defLine = definitionNode.startPosition.row + 1;
					const info = methodMap?.get(`${nodeName}:${defLine}`);
					if (info) {
						enrichedByMethodExtractor = true;
						arityForId = arityForIdFromInfo(info);
						methodProps = buildMethodProps(info);
						defMethodMap = methodMap;
						defMethodInfo = info;
					}
				}
			}

			// For top-level methods (e.g. Go method_declaration), try extractFromNode
			if (
				!enrichedByMethodExtractor &&
				provider.methodExtractor?.extractFromNode &&
				definitionNode
			) {
				const info = provider.methodExtractor.extractFromNode(definitionNode, {
					filePath: file.path,
					language,
				});
				if (info) {
					enrichedByMethodExtractor = true;
					arityForId = arityForIdFromInfo(info);
					methodProps = buildMethodProps(info);
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
		if (arityTag && defMethodMap && defMethodInfo) {
			const groups = buildCollisionGroups(defMethodMap);
			arityTag += typeTagForId(
				defMethodMap,
				nodeName,
				arityForId,
				defMethodInfo,
				language,
				groups,
			);
			arityTag += constTagForId(
				defMethodMap,
				nodeName,
				arityForId,
				defMethodInfo,
				groups,
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
		const classNodeForSymbol = definitionNode || nameNode;
		const qualifiedTypeName =
			extractedClassSymbol?.qualifiedName ??
			(classNodeForSymbol &&
			provider.classExtractor?.isTypeDeclaration(classNodeForSymbol)
				? (provider.classExtractor.extractQualifiedName(
						classNodeForSymbol,
						nodeName,
					) ?? nodeName)
				: undefined);

		const description = provider.descriptionExtractor?.(
			nodeLabel,
			nodeName,
			captureMap,
		);

		let frameworkHint = definitionNode
			? detectFrameworkFromAST(
					language,
					(definitionNode.text || "").slice(0, 300),
				)
			: null;

		// Suppress Spring framework hint for methods inside interfaces
		// (Feign clients, JAX-RS proxies are consumers, not providers)
		if (frameworkHint && definitionNode) {
			let classCheck = definitionNode.parent;
			while (classCheck) {
				if (classCheck.type === "interface_declaration") {
					frameworkHint = null;
					break;
				}
				if (
					classCheck.type === "class_declaration" ||
					classCheck.type === "program"
				) {
					break;
				}
				classCheck = classCheck.parent;
			}
		}

		// Decorators appear on lines immediately before their definition; allow up to
		// MAX_DECORATOR_SCAN_LINES gap for blank lines / multi-line decorator stacks.
		const MAX_DECORATOR_SCAN_LINES = 5;
		if (definitionNode) {
			const defStartLine = definitionNode.startPosition.row;
			for (
				let checkLine = defStartLine - 1;
				checkLine >= Math.max(0, defStartLine - MAX_DECORATOR_SCAN_LINES);
				checkLine--
			) {
				const dec = fileDecorators.get(checkLine);
				if (dec) {
					// Use first (closest) decorator found for framework hint
					if (!frameworkHint) {
						frameworkHint = {
							framework: "decorator",
							entryPointMultiplier: 1.2,
							reason: `@${dec.name}${dec.arg ? `("${dec.arg}")` : ""}`,
						};
					}
					// Emit tool definition if this is a @tool decorator
					if (dec.isTool) {
						result.toolDefs.push({
							filePath: file.path,
							toolName: nodeName,
							description: (dec.arg || description || "").slice(0, 200),
							lineNumber: definitionNode.startPosition.row + lineOffset,
							handlerNodeId: nodeId,
						});
					}
					fileDecorators.delete(checkLine);
				}
			}
		}

		// Property metadata extraction (not needed before nodeId — Properties don't overload)
		if (nodeLabel === "Property" && definitionNode) {
			// FieldExtractor is the single source of truth when available
			if (provider.fieldExtractor && typeEnv) {
				const classNode = findEnclosingClassNode(definitionNode);
				if (classNode) {
					const fieldMap = getFieldInfo(classNode, provider, {
						typeEnv,
						symbolTable: NOOP_SYMBOL_TABLE,
						filePath: file.path,
						language,
					});
					const info = fieldMap?.get(nodeName);
					if (info) {
						declaredType = info.type ?? undefined;
						methodProps.visibility = info.visibility;
						methodProps.isStatic = info.isStatic;
						methodProps.isReadonly = info.isReadonly;
					}
				}
			}
		}

		// Variable/Const/Static metadata extraction via VariableExtractor
		if (
			(nodeLabel === "Const" ||
				nodeLabel === "Static" ||
				nodeLabel === "Variable") &&
			definitionNode &&
			provider.variableExtractor
		) {
			const varCtx: VariableExtractorContext = {
				filePath: file.path,
				language,
			};
			const varInfo = provider.variableExtractor.extract(definitionNode, varCtx);
			if (varInfo) {
				if (varInfo.type) declaredType = varInfo.type;
				methodProps.visibility = varInfo.visibility;
				methodProps.isStatic = varInfo.isStatic;
				methodProps.isConst = varInfo.isConst;
				methodProps.isMutable = varInfo.isMutable;
				methodProps.scope = varInfo.scope;
			}
		}

		result.nodes.push({
			id: nodeId,
			label: nodeLabel,
			properties: {
				name: nodeName,
				filePath: file.path,
				startLine: definitionNode
					? definitionNode.startPosition.row + lineOffset
					: startLine,
				endLine: definitionNode
					? definitionNode.endPosition.row + lineOffset
					: startLine,
				language: language,
				isExported:
					language === SupportedLanguages.Vue && isVueSetup
						? isVueSetupTopLevel(nameNode || definitionNode)
						: cachedExportCheck(
								provider.exportChecker,
								nameNode || definitionNode,
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
				...(description !== undefined ? { description } : {}),
				...methodProps,
				...(declaredType !== undefined ? { declaredType } : {}),
			},
		});

		// enclosingClassId already computed above (before nodeId generation)

		result.symbols.push({
			filePath: file.path,
			name: nodeName,
			nodeId,
			type: nodeLabel,
			...(qualifiedTypeName !== undefined
				? { qualifiedName: qualifiedTypeName }
				: {}),
			parameterCount: methodProps.parameterCount as number | undefined,
			requiredParameterCount: methodProps.requiredParameterCount as
				| number
				| undefined,
			parameterTypes: methodProps.parameterTypes as string[] | undefined,
			returnType: methodProps.returnType as string | undefined,
			...(declaredType !== undefined ? { declaredType } : {}),
			...(classTemplateArguments !== undefined &&
			classTemplateArguments.length > 0
				? { templateArguments: classTemplateArguments }
				: {}),
			...(enclosingClassId ? { ownerId: enclosingClassId } : {}),
			visibility: methodProps.visibility as string | undefined,
			isStatic: methodProps.isStatic as boolean | undefined,
			isReadonly: methodProps.isReadonly as boolean | undefined,
			isAbstract: methodProps.isAbstract as boolean | undefined,
			isFinal: methodProps.isFinal as boolean | undefined,
			...(methodProps.isVirtual !== undefined
				? { isVirtual: methodProps.isVirtual as boolean }
				: {}),
			...(methodProps.isOverride !== undefined
				? { isOverride: methodProps.isOverride as boolean }
				: {}),
			...(methodProps.isAsync !== undefined
				? { isAsync: methodProps.isAsync as boolean }
				: {}),
			...(methodProps.isPartial !== undefined
				? { isPartial: methodProps.isPartial as boolean }
				: {}),
			...(methodProps.annotations !== undefined
				? { annotations: methodProps.annotations as string[] }
				: {}),
		});

		const fileId = generateId("File", file.path);
		const relId = generateId("DEFINES", `${fileId}->${nodeId}`);
		result.relationships.push({
			id: relId,
			sourceId: fileId,
			targetId: nodeId,
			type: "DEFINES",
			confidence: 1.0,
			reason: "",
		});

		// ── HAS_METHOD / HAS_PROPERTY: link member to enclosing class ──
		if (enclosingClassId) {
			const memberEdgeType =
				nodeLabel === "Property" ? "HAS_PROPERTY" : "HAS_METHOD";
			result.relationships.push({
				id: generateId(memberEdgeType, `${enclosingClassId}->${nodeId}`),
				sourceId: enclosingClassId,
				targetId: nodeId,
				type: memberEdgeType,
				confidence: 1.0,
				reason: "",
			});
		}
	}
};
