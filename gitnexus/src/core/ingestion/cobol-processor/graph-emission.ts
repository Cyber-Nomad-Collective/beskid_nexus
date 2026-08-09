import type { KnowledgeGraph } from "../../graph/types.js";
import type { CobolRegexResults } from "../cobol/cobol-preprocessor.js";
import type { CobolFile, CopyResolution } from "./contracts.js";
import { emitDataDivision } from "./data-division.js";
import { emitGraphDetails } from "./graph-details.js";
import { createGraphLookups } from "./model.js";
import { emitProcedureAndCalls } from "./procedure-calls.js";
import { emitProgramStructure } from "./program-structure.js";

export function mapToGraph(
	graph: KnowledgeGraph,
	extracted: CobolRegexResults,
	file: CobolFile,
	copyResolutions: CopyResolution[],
	moduleNodeIds: Map<string, string>,
): void {
	const structure = emitProgramStructure(graph, extracted, file, moduleNodeIds);
	const dataItemMap = emitDataDivision(graph, extracted, structure);
	const lookups = createGraphLookups(
		extracted,
		structure.paraNodeIds,
		structure.sectionNodeIds,
		structure.programModuleIds,
		structure.parentId,
	);
	emitProcedureAndCalls(
		graph,
		extracted,
		copyResolutions,
		moduleNodeIds,
		structure,
		dataItemMap,
		lookups,
	);
	emitGraphDetails(
		graph,
		extracted,
		moduleNodeIds,
		structure,
		dataItemMap,
		lookups,
	);
}

