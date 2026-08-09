import { SupportedLanguages } from "gitnexus-shared";
import { generateId } from "../../../lib/utils.js";
import type { KnowledgeGraph } from "../../graph/types.js";
import type { CobolRegexResults } from "../cobol/cobol-preprocessor.js";
import {
	findOwningProgramName,
} from "./model.js";
import type { ProgramStructureContext } from "./program-structure.js";

/** Generate a deterministic Property node ID using composite key (section:level:name). */
export function generatePropertyId(
	filePath: string,
	item: { section: string; level: number; name: string },
): string {
	return generateId(
		"Property",
		`${filePath}:${item.section}:${item.level}:${item.name}`,
	);
}

/**
 * Build a lookup Map from data item name (uppercase) to its Property node ID.
 * First-wins semantics: if the same name appears in multiple sections,
 * the first occurrence in extraction order is used for MOVE edge resolution.
 */
export function buildDataItemMap(
	dataItems: CobolRegexResults["dataItems"],
	filePath: string,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const item of dataItems) {
		if (item.name === "FILLER") continue;
		const key = item.name.toUpperCase();
		if (!map.has(key)) {
			map.set(key, generatePropertyId(filePath, item));
		}
	}
	return map;
}

export function emitDataDivision(
	graph: KnowledgeGraph,
	extracted: CobolRegexResults,
	structure: ProgramStructureContext,
): Map<string, string> {
	const { filePath, programModuleIds, parentId } = structure;
	// ── Data items -> Property nodes ─────────────────────────────────
	for (const item of extracted.dataItems) {
		if (item.name === "FILLER") continue; // Skip anonymous fillers
		const propId = generatePropertyId(filePath, item);
		const itemOwner = findOwningProgramName(item.line, extracted.programs);
		const itemParent = programModuleIds.get(itemOwner ?? "") ?? parentId;
		graph.addNode({
			id: propId,
			label: "Property",
			properties: {
				name: item.name,
				filePath,
				startLine: item.line,
				endLine: item.line,
				language: SupportedLanguages.Cobol,
				description: `level:${item.level} section:${item.section}${item.pic ? ` pic:${item.pic}` : ""}`,
			},
		});
		graph.addRelationship({
			id: generateId("CONTAINS", `${itemParent}->${propId}`),
			type: "CONTAINS",
			sourceId: itemParent,
			targetId: propId,
			confidence: 1.0,
			reason: "cobol-data-item",
		});
	}

	// ── Build data item Map early (needed by CALL USING, CICS INTO/FROM, MOVE, and USING) ──
	const dataItemMap = buildDataItemMap(extracted.dataItems, filePath);

	// ── OCCURS DEPENDING ON -> ACCESSES edges (variable-length table deps) ──
	for (const item of extracted.dataItems) {
		if (item.name === "FILLER" || !item.dependingOn) continue;
		const propId = generatePropertyId(filePath, item);
		const depFieldId = dataItemMap.get(item.dependingOn.toUpperCase());
		if (depFieldId) {
			graph.addRelationship({
				id: generateId("ACCESSES", `${propId}->depends-on->${item.dependingOn}`),
				type: "ACCESSES",
				sourceId: propId,
				targetId: depFieldId,
				confidence: 1.0,
				reason: "cobol-depends-on",
			});
		}
	}

	return dataItemMap;
}

