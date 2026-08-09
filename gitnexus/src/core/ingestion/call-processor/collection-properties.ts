import {
	NOOP_SYMBOL_TABLE,
	findEnclosingClassInfo,
	findEnclosingClassNode,
	generateId,
	getFieldInfo,
} from "./context.js";
import type {
	Parser,
	buildTypeEnv,
	FieldInfo,
	getProvider,
	KnowledgeGraph,
	ResolutionContext,
	SupportedLanguages,
} from "./context.js";
import { resolveFieldOwnership } from "./receiver-fields.js";

export interface PreparedFile {
	file: { path: string; content: string };
	language: SupportedLanguages;
	provider: ReturnType<typeof getProvider>;
	tree: ReturnType<Parser["parse"]>;
	matches: ReturnType<Parser.Query["matches"]>;
	parentMap: ReadonlyMap<string, readonly string[]>;
	typeEnv: ReturnType<typeof buildTypeEnv>;
}

export interface PendingWrite {
	receiverTypeName: string;
	propertyName: string;
	filePath: string;
	srcId: string;
	line?: number;
}

/**
 * Registers routed properties before call resolution so cross-file field-type
 * lookups are independent of file processing order.
 */
export const registerRoutedProperties = (
	graph: KnowledgeGraph,
	prepared: readonly PreparedFile[],
	ctx: ResolutionContext,
): void => {
	const fieldInfoCache = new Map<string, Map<string, FieldInfo>>();
	for (const { file, language, provider, matches, typeEnv } of prepared) {
		const callRouter = provider.callRouter;
		if (!callRouter) continue;
		matches.forEach((match) => {
			const captureMap: Record<string, any> = {};
			match.captures.forEach((c) => (captureMap[c.name] = c.node));
			if (!captureMap.call) return;
			const callNameNode = captureMap["call.name"];
			if (!callNameNode) return;
			const routed = callRouter(callNameNode.text, captureMap.call);
			if (routed?.kind !== "properties") return;

			const propEnclosingInfo = findEnclosingClassInfo(
				captureMap.call,
				file.path,
				provider.resolveEnclosingOwner,
			);
			const propEnclosingClassId = propEnclosingInfo?.classId ?? null;

			// Enrich routed properties with FieldExtractor metadata so types
			// discovered from constructor assignments (e.g. `@address = Address.new`)
			// are propagated even when the routing payload itself lacks declaredType.
			let routedFieldMap: Map<string, FieldInfo> | undefined;
			if (provider.fieldExtractor && typeEnv) {
				const classNode = findEnclosingClassNode(captureMap.call);
				if (classNode) {
					routedFieldMap = getFieldInfo(
						classNode,
						provider,
						{
							typeEnv,
							symbolTable: NOOP_SYMBOL_TABLE,
							filePath: file.path,
							language,
						},
						fieldInfoCache,
					);
				}
			}

			const fileId = generateId("File", file.path);
			for (const item of routed.items) {
				const routedFieldInfo = routedFieldMap?.get(item.propName);
				const propQualifiedName = propEnclosingInfo
					? `${propEnclosingInfo.className}.${item.propName}`
					: item.propName;
				const nodeId = generateId("Property", `${file.path}:${propQualifiedName}`);
				graph.addNode({
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
				ctx.model.symbols.add(file.path, item.propName, nodeId, "Property", {
					...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
					...(item.declaredType
						? { declaredType: item.declaredType }
						: routedFieldInfo?.type
							? { declaredType: routedFieldInfo.type }
							: {}),
				});
				const relId = generateId("DEFINES", `${fileId}->${nodeId}`);
				graph.addRelationship({
					id: relId,
					sourceId: fileId,
					targetId: nodeId,
					type: "DEFINES",
					confidence: 1.0,
					reason: "",
				});
				if (propEnclosingClassId) {
					graph.addRelationship({
						id: generateId("HAS_PROPERTY", `${propEnclosingClassId}->${nodeId}`),
						sourceId: propEnclosingClassId,
						targetId: nodeId,
						type: "HAS_PROPERTY",
						confidence: 1.0,
						reason: "",
					});
				}
			}
		});
	}
};

export const emitDeferredWriteAccesses = (
	graph: KnowledgeGraph,
	pendingWrites: readonly PendingWrite[],
	ctx: ResolutionContext,
): void => {
	for (const pw of pendingWrites) {
		const fieldOwner = resolveFieldOwnership(
			pw.receiverTypeName,
			pw.propertyName,
			pw.filePath,
			ctx,
		);
		if (fieldOwner) {
			graph.addRelationship({
				id: generateId(
					"ACCESSES",
					`${pw.srcId}:${fieldOwner.nodeId}:write${pw.line !== undefined ? `:${pw.line}` : ""}`,
				),
				sourceId: pw.srcId,
				targetId: fieldOwner.nodeId,
				type: "ACCESSES",
				confidence: 1.0,
				reason: "write",
			});
		}
	}
};
