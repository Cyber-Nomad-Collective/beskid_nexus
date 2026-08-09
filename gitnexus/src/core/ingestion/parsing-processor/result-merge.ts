import type { NodeLabel, ParsedFile } from "gitnexus-shared";
import type { KnowledgeGraph } from "../../graph/types.js";
import type {
	ExtractedHeritage,
	SymbolTableWriter,
} from "../model/index.js";
import type {
	ExtractedAssignment,
	ExtractedCall,
	ExtractedDecoratorRoute,
	ExtractedFetchCall,
	ExtractedImport,
	ExtractedORMQuery,
	ExtractedRoute,
	ExtractedToolDef,
	FileConstructorBindings,
	FileScopeBindings,
	ParseWorkerResult,
} from "../workers/parse-worker.js";
import type { WorkerExtractedData } from "./contracts.js";

/**
 * Merge a list of `ParseWorkerResult`s into the running graph + symbol
 * table state and produce the chunk-aggregated `WorkerExtractedData`.
 *
 * Extracted from `processParsingWithWorkers` so the same merge logic can
 * be applied to both freshly-parsed worker output AND cached worker
 * output replayed during incremental analyze. Idempotent on the
 * accumulator fields (push-only); idempotent on graph if the caller
 * starts from a clean graph (otherwise duplicate `addNode` calls are
 * silently no-op'd by `KnowledgeGraph`).
 */
export const mergeChunkResults = (
	graph: KnowledgeGraph,
	symbolTable: SymbolTableWriter,
	chunkResults: readonly ParseWorkerResult[],
): WorkerExtractedData => {
	const allImports: ExtractedImport[] = [];
	const allCalls: ExtractedCall[] = [];
	const allAssignments: ExtractedAssignment[] = [];
	const allHeritage: ExtractedHeritage[] = [];
	const allRoutes: ExtractedRoute[] = [];
	const allFetchCalls: ExtractedFetchCall[] = [];
	const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
	const allToolDefs: ExtractedToolDef[] = [];
	const allORMQueries: ExtractedORMQuery[] = [];
	const allConstructorBindings: FileConstructorBindings[] = [];
	const fileScopeBindingsByFile: FileScopeBindings[] = [];
	const allParsedFiles: ParsedFile[] = [];

	for (const result of chunkResults) {
		for (const node of result.nodes) {
			graph.addNode({
				id: node.id,
				label: node.label as NodeLabel,
				properties: node.properties,
			});
		}
		for (const rel of result.relationships) {
			graph.addRelationship(rel);
		}
		for (const sym of result.symbols) {
			symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type, {
				parameterCount: sym.parameterCount,
				requiredParameterCount: sym.requiredParameterCount,
				parameterTypes: sym.parameterTypes,
				returnType: sym.returnType,
				declaredType: sym.declaredType,
				templateArguments: sym.templateArguments,
				ownerId: sym.ownerId,
				qualifiedName: sym.qualifiedName,
			});
		}
		for (const item of result.imports) allImports.push(item);
		for (const item of result.calls) allCalls.push(item);
		for (const item of result.assignments) allAssignments.push(item);
		for (const item of result.heritage) allHeritage.push(item);
		for (const item of result.routes) allRoutes.push(item);
		for (const item of result.fetchCalls) allFetchCalls.push(item);
		for (const item of result.decoratorRoutes) allDecoratorRoutes.push(item);
		for (const item of result.toolDefs) allToolDefs.push(item);
		if (result.ormQueries)
			for (const item of result.ormQueries) allORMQueries.push(item);
		for (const item of result.constructorBindings)
			allConstructorBindings.push(item);
		if (result.fileScopeBindings)
			for (const item of result.fileScopeBindings)
				fileScopeBindingsByFile.push(item);
		if (result.parsedFiles)
			for (const item of result.parsedFiles) allParsedFiles.push(item);
	}

	return {
		imports: allImports,
		calls: allCalls,
		assignments: allAssignments,
		heritage: allHeritage,
		routes: allRoutes,
		fetchCalls: allFetchCalls,
		decoratorRoutes: allDecoratorRoutes,
		toolDefs: allToolDefs,
		ormQueries: allORMQueries,
		constructorBindings: allConstructorBindings,
		fileScopeBindings: fileScopeBindingsByFile,
		parsedFiles: allParsedFiles,
	};
};
