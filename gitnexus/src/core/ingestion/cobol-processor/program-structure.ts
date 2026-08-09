import { SupportedLanguages } from "gitnexus-shared";
import { generateId } from "../../../lib/utils.js";
import type { KnowledgeGraph } from "../../graph/types.js";
import type { CobolRegexResults } from "../cobol/cobol-preprocessor.js";
import type { CobolFile } from "./contracts.js";
import {
	findContainingSection,
	findOwningProgramName,
} from "./model.js";

export interface ProgramStructureContext {
	filePath: string;
	lines: string[];
	fileNodeId: string;
	moduleId: string | undefined;
	programModuleIds: Map<string, string>;
	parentId: string;
	sectionNodeIds: Map<string, string>;
	paraNodeIds: Map<string, string>;
}

export function emitProgramStructure(
	graph: KnowledgeGraph,
	extracted: CobolRegexResults,
	file: CobolFile,
	moduleNodeIds: Map<string, string>,
): ProgramStructureContext {
	const { path: filePath, content } = file;
	const lines = content.split(/\r?\n/);
	const fileNodeId = generateId("File", filePath);

	// ── PROGRAM-ID -> Module node ────────────────────────────────────
	let moduleId: string | undefined;
	if (extracted.programName) {
		moduleId = generateId("Module", `${filePath}:${extracted.programName}`);
		const metaDesc = [
			extracted.programMetadata.author &&
				`author:${extracted.programMetadata.author}`,
			extracted.programMetadata.dateWritten &&
				`date:${extracted.programMetadata.dateWritten}`,
			extracted.programMetadata.dateCompiled &&
				`compiled:${extracted.programMetadata.dateCompiled}`,
			extracted.programMetadata.installation &&
				`install:${extracted.programMetadata.installation}`,
		]
			.filter(Boolean)
			.join(" ");
		graph.addNode({
			id: moduleId,
			label: "Module",
			properties: {
				name: extracted.programName,
				filePath,
				startLine: 1,
				endLine: lines.length,
				language: SupportedLanguages.Cobol,
				isExported: true,
				description: metaDesc || undefined,
			},
		});
		graph.addRelationship({
			id: generateId("CONTAINS", `${fileNodeId}->${moduleId}`),
			type: "CONTAINS",
			sourceId: fileNodeId,
			targetId: moduleId,
			confidence: 1.0,
			reason: "cobol-program-id",
		});
		moduleNodeIds.set(extracted.programName.toUpperCase(), moduleId);
	}

	// ── Nested programs -> additional Module nodes ───────────────────
	// programs[] contains all PROGRAM-IDs with line ranges. The first entry
	// is the primary (outer) program (already created above). Additional
	// entries are nested programs that get their own Module nodes.
	const programModuleIds = new Map<string, string>();
	if (moduleId) {
		programModuleIds.set(extracted.programName?.toUpperCase(), moduleId);
	}
	for (const prog of extracted.programs) {
		if (prog.name.toUpperCase() === extracted.programName?.toUpperCase())
			continue; // skip primary
		const nestedModuleId = generateId("Module", `${filePath}:${prog.name}`);
		graph.addNode({
			id: nestedModuleId,
			label: "Module",
			properties: {
				name: prog.name,
				filePath,
				startLine: prog.startLine,
				endLine: prog.endLine,
				language: SupportedLanguages.Cobol,
				isExported: true,
				description: `nested-program${prog.isCommon ? " common" : ""}`,
			},
		});
		// Find enclosing program by line-range containment
		const enclosing = extracted.programs.find(
			(p) =>
				p.startLine < prog.startLine &&
				p.endLine > prog.endLine &&
				p.nestingDepth < prog.nestingDepth,
		);
		const nestedParent = enclosing
			? (programModuleIds.get(enclosing.name.toUpperCase()) ??
				moduleId ??
				fileNodeId)
			: (moduleId ?? fileNodeId);
		graph.addRelationship({
			id: generateId("CONTAINS", `${nestedParent}->${nestedModuleId}`),
			type: "CONTAINS",
			sourceId: nestedParent,
			targetId: nestedModuleId,
			confidence: 1.0,
			reason: "cobol-nested-program",
		});
		moduleNodeIds.set(prog.name.toUpperCase(), nestedModuleId);
		programModuleIds.set(prog.name.toUpperCase(), nestedModuleId);
	}

	const parentId = moduleId ?? fileNodeId;

	// ── SECTIONs -> Namespace nodes ──────────────────────────────────
	const sectionNodeIds = new Map<string, string>();
	for (let i = 0; i < extracted.sections.length; i++) {
		const sec = extracted.sections[i];
		const nextLine =
			i + 1 < extracted.sections.length
				? extracted.sections[i + 1].line - 1
				: lines.length;
		const owningPgm = findOwningProgramName(sec.line, extracted.programs);
		const secId = generateId(
			"Namespace",
			`${filePath}:${owningPgm ? `${owningPgm}:` : ""}${sec.name}`,
		);
		graph.addNode({
			id: secId,
			label: "Namespace",
			properties: {
				name: sec.name,
				filePath,
				startLine: sec.line,
				endLine: nextLine,
				language: SupportedLanguages.Cobol,
				isExported: true,
			},
		});
		const secParent = programModuleIds.get(owningPgm ?? "") ?? parentId;
		graph.addRelationship({
			id: generateId("CONTAINS", `${secParent}->${secId}`),
			type: "CONTAINS",
			sourceId: secParent,
			targetId: secId,
			confidence: 1.0,
			reason: "cobol-section",
		});
		sectionNodeIds.set(`${owningPgm ?? ""}:${sec.name.toUpperCase()}`, secId);
	}

	// ── PARAGRAPHs -> Function nodes ─────────────────────────────────
	const paraNodeIds = new Map<string, string>();
	for (let i = 0; i < extracted.paragraphs.length; i++) {
		const para = extracted.paragraphs[i];
		const nextLine =
			i + 1 < extracted.paragraphs.length
				? extracted.paragraphs[i + 1].line - 1
				: lines.length;
		const owningPgmPara = findOwningProgramName(para.line, extracted.programs);
		const paraId = generateId(
			"Function",
			`${filePath}:${owningPgmPara ? `${owningPgmPara}:` : ""}${para.name}`,
		);
		graph.addNode({
			id: paraId,
			label: "Function",
			properties: {
				name: para.name,
				filePath,
				startLine: para.line,
				endLine: nextLine,
				language: SupportedLanguages.Cobol,
				isExported: true,
			},
		});
		// Parent: find the containing section, or fall back to module/file
		const containerId =
			findContainingSection(
				para.line,
				extracted.sections,
				sectionNodeIds,
				extracted.programs,
			) ??
			programModuleIds.get(owningPgmPara ?? "") ??
			parentId;
		graph.addRelationship({
			id: generateId("CONTAINS", `${containerId}->${paraId}`),
			type: "CONTAINS",
			sourceId: containerId,
			targetId: paraId,
			confidence: 1.0,
			reason: "cobol-paragraph",
		});
		paraNodeIds.set(`${owningPgmPara ?? ""}:${para.name.toUpperCase()}`, paraId);
	}

	return {
		filePath,
		lines,
		fileNodeId,
		moduleId,
		programModuleIds,
		parentId,
		sectionNodeIds,
		paraNodeIds,
	};
}

