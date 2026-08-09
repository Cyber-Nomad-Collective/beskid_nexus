import { SupportedLanguages } from "gitnexus-shared";
import type { LanguageProvider } from "../../language-provider.js";
import type { TypeEnvironment } from "../../type-env.js";
import type { FieldInfo } from "../../field-types.js";
import type { SyntaxNode } from "../../utils/ast-helpers.js";
import { extractCallArgTypes } from "../../utils/call-analysis.js";
import { generateId } from "../../../../lib/utils.js";
import {
	cachedFindEnclosingClassInfo,
	findEnclosingClassNode,
	findEnclosingFunctionId,
	getFieldInfo,
	NOOP_SYMBOL_TABLE,
} from "./extraction-context.js";
import type { ParseWorkerInput, ParseWorkerResult } from "./protocol.js";

interface CallCaptureContext {
	captureMap: Record<string, SyntaxNode>;
	file: ParseWorkerInput;
	language: SupportedLanguages;
	provider: LanguageProvider;
	typeEnv: TypeEnvironment;
	callRouter: LanguageProvider["callRouter"];
	result: ParseWorkerResult;
}

export const extractCallCapture = ({
	captureMap,
	file,
	language,
	provider,
	typeEnv,
	callRouter,
	result,
}: CallCaptureContext): void => {
	const callNode = captureMap.call;
	const callNameNode = captureMap["call.name"];
	const callExtractor = provider.callExtractor;

	if (callExtractor) {
		// ── Path 1: Language-specific call site (bypasses routing) ────
		// Try language-specific extraction (e.g. Java `::` method references)
		// without callNameNode.  If successful, skip routing and the generic
		// path entirely.
		const langCallSite = callExtractor.extract(callNode, undefined);
		if (langCallSite) {
			if (!provider.isBuiltInName(langCallSite.calledName)) {
				const sourceId =
					findEnclosingFunctionId(callNode, file.path, provider) ||
					generateId("File", file.path);
				const receiverName =
					langCallSite.callForm === "member"
						? langCallSite.receiverName
						: undefined;
				let receiverTypeName = receiverName
					? typeEnv.lookup(receiverName, callNode)
					: undefined;
				// Type-as-receiver heuristic (e.g. Java `User::getName`)
				if (
					langCallSite.typeAsReceiverHeuristic &&
					receiverName !== undefined &&
					receiverTypeName === undefined &&
					langCallSite.callForm === "member"
				) {
					const c0 = receiverName.charCodeAt(0);
					if (c0 >= 65 && c0 <= 90) receiverTypeName = receiverName;
				}
				result.calls.push({
					filePath: file.path,
					calledName: langCallSite.calledName,
					sourceId,
					callForm: langCallSite.callForm,
					...(receiverName !== undefined ? { receiverName } : {}),
					...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
				});
			}
			return;
		}

		// ── Path 2: Generic extraction via @call.name ────────────────
		if (callNameNode) {
			const calledName = callNameNode.text;

			// Check heritage extractor for call-based heritage (e.g., Ruby include/extend/prepend)
			if (provider.heritageExtractor?.extractFromCall) {
				const heritageItems = provider.heritageExtractor.extractFromCall(
					calledName,
					callNode,
					{ filePath: file.path, language },
				);
				if (heritageItems !== null) {
					for (const item of heritageItems) {
						result.heritage.push({
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
				if (routed.kind === "skip") return;

				if (routed.kind === "import") {
					result.imports.push({
						filePath: file.path,
						rawImportPath: routed.importPath,
						language,
					});
					return;
				}

				if (routed.kind === "properties") {
					const propEnclosingInfo = cachedFindEnclosingClassInfo(
						captureMap.call,
						file.path,
						provider.resolveEnclosingOwner,
					);
					const propEnclosingClassId = propEnclosingInfo?.classId ?? null;
					// Enrich routed properties with FieldExtractor metadata
					let routedFieldMap: Map<string, FieldInfo> | undefined;
					if (provider.fieldExtractor && typeEnv) {
						const classNode = findEnclosingClassNode(captureMap.call);
						if (classNode) {
							routedFieldMap = getFieldInfo(classNode, provider, {
								typeEnv,
								symbolTable: NOOP_SYMBOL_TABLE,
								filePath: file.path,
								language,
							});
						}
					}
					for (const item of routed.items) {
						const routedFieldInfo = routedFieldMap?.get(item.propName);
						const propQualifiedName = propEnclosingInfo
							? `${propEnclosingInfo.className}.${item.propName}`
							: item.propName;
						const nodeId = generateId(
							"Property",
							`${file.path}:${propQualifiedName}`,
						);
						result.nodes.push({
							id: nodeId,
							label: "Property",
							properties: {
								name: item.propName,
								filePath: file.path,
								startLine: item.startLine,
								endLine: item.endLine,
								language,
								isExported: true,
								description: item.accessorType,
								...(item.declaredType
									? { declaredType: item.declaredType }
									: routedFieldInfo?.type
										? { declaredType: routedFieldInfo.type }
										: {}),
								...(routedFieldInfo?.visibility !== undefined
									? { visibility: routedFieldInfo.visibility }
									: {}),
								...(routedFieldInfo?.isStatic !== undefined
									? { isStatic: routedFieldInfo.isStatic }
									: {}),
								...(routedFieldInfo?.isReadonly !== undefined
									? { isReadonly: routedFieldInfo.isReadonly }
									: {}),
							},
						});
						result.symbols.push({
							filePath: file.path,
							name: item.propName,
							nodeId,
							type: "Property",
							...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
							...(item.declaredType
								? { declaredType: item.declaredType }
								: routedFieldInfo?.type
									? { declaredType: routedFieldInfo.type }
									: {}),
							...(routedFieldInfo?.visibility !== undefined
								? { visibility: routedFieldInfo.visibility }
								: {}),
							...(routedFieldInfo?.isStatic !== undefined
								? { isStatic: routedFieldInfo.isStatic }
								: {}),
							...(routedFieldInfo?.isReadonly !== undefined
								? { isReadonly: routedFieldInfo.isReadonly }
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
						if (propEnclosingClassId) {
							result.relationships.push({
								id: generateId("HAS_PROPERTY", `${propEnclosingClassId}->${nodeId}`),
								sourceId: propEnclosingClassId,
								targetId: nodeId,
								type: "HAS_PROPERTY",
								confidence: 1.0,
								reason: "",
							});
						}
					}
					return;
				}

				// kind === 'call' — fall through to normal call processing below
			}

			if (!provider.isBuiltInName(calledName)) {
				const callSite = callExtractor.extract(callNode, callNameNode);
				if (callSite) {
					const sourceId =
						findEnclosingFunctionId(callNode, file.path, provider) ||
						generateId("File", file.path);
					let receiverTypeName = callSite.receiverName
						? typeEnv.lookup(callSite.receiverName, callNode)
						: undefined;

					// Type-as-receiver heuristic
					if (
						callSite.typeAsReceiverHeuristic &&
						callSite.receiverName !== undefined &&
						receiverTypeName === undefined &&
						callSite.callForm === "member"
					) {
						const c0 = callSite.receiverName.charCodeAt(0);
						if (c0 >= 65 && c0 <= 90) receiverTypeName = callSite.receiverName;
					}

					const inferLiteralType = provider.typeConfig?.inferLiteralType;
					// Skip when no arg list / zero args: nothing to infer for overload typing
					const argTypes =
						inferLiteralType &&
						callSite.argCount !== undefined &&
						callSite.argCount > 0
							? extractCallArgTypes(callNode, inferLiteralType, (varName, cn) =>
									typeEnv.lookup(varName, cn),
								)
							: undefined;

					result.calls.push({
						filePath: file.path,
						calledName: callSite.calledName,
						sourceId,
						...(callSite.argCount !== undefined
							? { argCount: callSite.argCount }
							: {}),
						...(callSite.callForm !== undefined
							? { callForm: callSite.callForm }
							: {}),
						...(callSite.receiverName !== undefined
							? { receiverName: callSite.receiverName }
							: {}),
						...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
						...(callSite.receiverMixedChain !== undefined
							? { receiverMixedChain: callSite.receiverMixedChain }
							: {}),
						...(argTypes !== undefined ? { argTypes } : {}),
					});
				}
			}
		}
	}
};

