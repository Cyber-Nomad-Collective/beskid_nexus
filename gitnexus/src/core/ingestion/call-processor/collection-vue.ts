import { extractTemplateComponents, generateId } from "./context.js";
import type { KnowledgeGraph, ResolutionContext } from "./context.js";

export const emitVueTemplateComponentCalls = (
	graph: KnowledgeGraph,
	file: { path: string; content: string },
	ctx: ResolutionContext,
): void => {
	const templateComponents = extractTemplateComponents(file.content);
	if (templateComponents.length > 0) {
		const fileId = generateId("File", file.path);
		const importedFiles = ctx.importMap.get(file.path);
		if (importedFiles) {
			for (const componentName of templateComponents) {
				for (const importedPath of importedFiles) {
					if (!importedPath.endsWith(".vue")) continue;
					const basename = importedPath.slice(
						importedPath.lastIndexOf("/") + 1,
						importedPath.lastIndexOf("."),
					);
					if (basename !== componentName) continue;
					const targetFileId = generateId("File", importedPath);
					if (graph.getNode(targetFileId)) {
						graph.addRelationship({
							id: generateId("CALLS", `${fileId}:${componentName}->${targetFileId}`),
							sourceId: fileId,
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
	}
};
