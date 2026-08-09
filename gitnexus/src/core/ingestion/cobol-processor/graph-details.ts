import { SupportedLanguages } from "gitnexus-shared";
import { generateId } from "../../../lib/utils.js";
import type { KnowledgeGraph } from "../../graph/types.js";
import type { CobolRegexResults } from "../cobol/cobol-preprocessor.js";
import {
	findOwningProgramName,
	type CobolGraphLookups,
} from "./model.js";
import type { ProgramStructureContext } from "./program-structure.js";

export function emitGraphDetails(
	graph: KnowledgeGraph,
	extracted: CobolRegexResults,
	moduleNodeIds: Map<string, string>,
	structure: ProgramStructureContext,
	dataItemMap: Map<string, string>,
	lookups: CobolGraphLookups,
): void {
	const {
		filePath,
		programModuleIds,
		parentId,
		sectionNodeIds,
	} = structure;
	const { scopedParaLookup, scopedCallerLookup, owningModuleId } = lookups;
	// ── DECLARATIVES error handlers -> ACCESSES edges ──────────────────
	for (const decl of extracted.declaratives) {
		// Find the section's Namespace node
		const pgm = findOwningProgramName(decl.line, extracted.programs);
		const sectionId = sectionNodeIds.get(
			`${pgm ?? ""}:${decl.sectionName.toUpperCase()}`,
		);
		if (!sectionId) continue;

		// Create ACCESSES edge from handler section to file/mode
		const targetId = generateId("Record", `${filePath}:${decl.target}`);
		graph.addRelationship({
			id: generateId(
				"ACCESSES",
				`${sectionId}->error-handler->${decl.target}:L${decl.line}`,
			),
			type: "ACCESSES",
			sourceId: sectionId,
			targetId,
			confidence: 0.9,
			reason: "cobol-error-handler",
		});
	}

	// ── SET statement -> ACCESSES edges ──────────────────
	for (const set of extracted.sets) {
		const callerId = scopedCallerLookup(set.caller, set.line);
		const reason =
			set.form === "to-true" ? "cobol-set-condition" : "cobol-set-index";
		for (const target of set.targets) {
			const targetPropId = dataItemMap.get(target.toUpperCase());
			if (targetPropId) {
				graph.addRelationship({
					id: generateId("ACCESSES", `${callerId}->set->${target}:L${set.line}`),
					type: "ACCESSES",
					sourceId: callerId,
					targetId: targetPropId,
					confidence: 0.9,
					reason,
				});
			}
		}
		// If SET index has a value that is an identifier (not a number), add read edge
		if (set.value && /^[A-Z][A-Z0-9-]+$/i.test(set.value)) {
			const valuePropId = dataItemMap.get(set.value.toUpperCase());
			if (valuePropId) {
				graph.addRelationship({
					id: generateId(
						"ACCESSES",
						`${callerId}->set-read->${set.value}:L${set.line}`,
					),
					type: "ACCESSES",
					sourceId: callerId,
					targetId: valuePropId,
					confidence: 0.9,
					reason: "cobol-set-read",
				});
			}
		}
	}

	// ── INSPECT -> ACCESSES edges ──────────────────
	for (const insp of extracted.inspects) {
		const callerId = scopedCallerLookup(insp.caller, insp.line);
		const inspFieldId = dataItemMap.get(insp.inspectedField.toUpperCase());
		if (inspFieldId) {
			// Read edge (always — INSPECT reads the field)
			graph.addRelationship({
				id: generateId(
					"ACCESSES",
					`${callerId}->inspect-read->${insp.inspectedField}:L${insp.line}`,
				),
				type: "ACCESSES",
				sourceId: callerId,
				targetId: inspFieldId,
				confidence: 0.9,
				reason: "cobol-inspect-read",
			});
			// Write edge (if REPLACING or CONVERTING — modifies the field in-place)
			if (insp.form !== "tallying") {
				graph.addRelationship({
					id: generateId(
						"ACCESSES",
						`${callerId}->inspect-write->${insp.inspectedField}:L${insp.line}`,
					),
					type: "ACCESSES",
					sourceId: callerId,
					targetId: inspFieldId,
					confidence: 0.9,
					reason: "cobol-inspect-write",
				});
			}
		}
		// Tally counter write edges
		for (const counter of insp.counters) {
			const counterPropId = dataItemMap.get(counter.toUpperCase());
			if (counterPropId) {
				graph.addRelationship({
					id: generateId(
						"ACCESSES",
						`${callerId}->inspect-tally->${counter}:L${insp.line}`,
					),
					type: "ACCESSES",
					sourceId: callerId,
					targetId: counterPropId,
					confidence: 0.9,
					reason: "cobol-inspect-tally",
				});
			}
		}
	}

	// ── INITIALIZE -> ACCESSES write edges ──────────────────
	for (const init of extracted.initializes) {
		const callerId = scopedCallerLookup(init.caller, init.line);
		const targetPropId = dataItemMap.get(init.target.toUpperCase());
		if (targetPropId) {
			graph.addRelationship({
				id: generateId(
					"ACCESSES",
					`${callerId}->initialize->${init.target}:L${init.line}`,
				),
				type: "ACCESSES",
				sourceId: callerId,
				targetId: targetPropId,
				confidence: 0.9,
				reason: "cobol-initialize",
			});
		}
	}

	// ── EXEC DLI (IMS/DB) -> CodeElement + ACCESSES edges ──────────────
	for (const dli of extracted.execDliBlocks) {
		const dliId = generateId("CodeElement", `${filePath}:exec-dli:L${dli.line}`);
		const dliOwner = owningModuleId(dli.line);
		graph.addNode({
			id: dliId,
			label: "CodeElement",
			properties: {
				name: `EXEC DLI ${dli.verb}`,
				filePath,
				startLine: dli.line,
				endLine: dli.line,
				language: SupportedLanguages.Cobol,
				description:
					[
						dli.segmentName && `segment:${dli.segmentName}`,
						dli.pcbNumber !== undefined && `pcb:${dli.pcbNumber}`,
						dli.psbName && `psb:${dli.psbName}`,
					]
						.filter(Boolean)
						.join(" ") || undefined,
			},
		});
		graph.addRelationship({
			id: generateId("CONTAINS", `${dliOwner}->${dliId}`),
			type: "CONTAINS",
			sourceId: dliOwner,
			targetId: dliId,
			confidence: 1.0,
			reason: "cobol-exec-dli",
		});
		// ACCESSES edge to IMS segment (like SQL table)
		if (dli.segmentName) {
			const segId = generateId("Record", `<ims>:${dli.segmentName}`);
			graph.addRelationship({
				id: generateId("ACCESSES", `${dliId}->${dli.segmentName}:${dli.verb}`),
				type: "ACCESSES",
				sourceId: dliId,
				targetId: segId,
				confidence: 0.9,
				reason: `dli-${dli.verb.toLowerCase()}`,
			});
		}
		// ACCESSES to INTO/FROM data areas
		if (dli.intoField) {
			const intoPropId = dataItemMap.get(dli.intoField.toUpperCase());
			if (intoPropId) {
				graph.addRelationship({
					id: generateId(
						"ACCESSES",
						`${dliId}->into->${dli.intoField}:L${dli.line}`,
					),
					type: "ACCESSES",
					sourceId: dliId,
					targetId: intoPropId,
					confidence: 0.9,
					reason: "dli-into",
				});
			}
		}
		if (dli.fromField) {
			const fromPropId = dataItemMap.get(dli.fromField.toUpperCase());
			if (fromPropId) {
				graph.addRelationship({
					id: generateId(
						"ACCESSES",
						`${dliId}->from->${dli.fromField}:L${dli.line}`,
					),
					type: "ACCESSES",
					sourceId: dliId,
					targetId: fromPropId,
					confidence: 0.9,
					reason: "dli-from",
				});
			}
		}
	}

	// ── MOVE data flow -> ACCESSES edges (read/write) ──────────────
	for (const move of extracted.moves) {
		const fromPropId = dataItemMap.get(move.from.toUpperCase());
		const callerId = scopedCallerLookup(move.caller, move.line);

		// One read edge per MOVE (regardless of number of targets)
		if (fromPropId) {
			graph.addRelationship({
				id: generateId("ACCESSES", `${callerId}->read->${move.from}:L${move.line}`),
				type: "ACCESSES",
				sourceId: callerId,
				targetId: fromPropId,
				confidence: 0.9,
				reason: move.corresponding
					? "cobol-move-corresponding-read"
					: "cobol-move-read",
			});
		}

		// One write edge per target
		for (const target of move.targets) {
			const toPropId = dataItemMap.get(target.toUpperCase());
			if (toPropId) {
				graph.addRelationship({
					id: generateId("ACCESSES", `${callerId}->write->${target}:L${move.line}`),
					type: "ACCESSES",
					sourceId: callerId,
					targetId: toPropId,
					confidence: 0.9,
					reason: move.corresponding
						? "cobol-move-corresponding-write"
						: "cobol-move-write",
				});
			}
		}
	}

	// ── File declarations -> Record nodes ──────────────────────────
	for (const fd of extracted.fileDeclarations) {
		const fdId = generateId("Record", `${filePath}:${fd.selectName}`);
		graph.addNode({
			id: fdId,
			label: "Record",
			properties: {
				name: fd.selectName,
				filePath,
				startLine: fd.line,
				endLine: fd.line,
				language: SupportedLanguages.Cobol,
				description: `assign:${fd.assignTo}${fd.isOptional ? " optional" : ""}${fd.organization ? ` org:${fd.organization}` : ""}${fd.access ? ` access:${fd.access}` : ""}`,
			},
		});
		const fdOwner = owningModuleId(fd.line);
		graph.addRelationship({
			id: generateId("CONTAINS", `${fdOwner}->${fdId}`),
			type: "CONTAINS",
			sourceId: fdOwner,
			targetId: fdId,
			confidence: 1.0,
			reason: "cobol-file-declaration",
		});
	}

	// ── GO TO -> CALLS edges ──────────────────────────────────────
	for (const gt of extracted.gotos) {
		const callerId = scopedCallerLookup(gt.caller, gt.line);
		const targetId = scopedParaLookup(gt.target, gt.line);
		if (targetId) {
			graph.addRelationship({
				id: generateId("CALLS", `${callerId}->goto->${gt.target}:L${gt.line}`),
				type: "CALLS",
				sourceId: callerId,
				targetId,
				confidence: 1.0,
				reason: "cobol-goto",
			});
		}
	}

	// ── SORT/MERGE -> ACCESSES edges ──────────────────────────────
	for (const sort of extracted.sorts) {
		const sortFileId = generateId("Record", `${filePath}:${sort.sortFile}`);
		const sortOwner = owningModuleId(sort.line);
		for (const usingFile of sort.usingFiles) {
			const usingId = generateId("Record", `${filePath}:${usingFile}`);
			graph.addRelationship({
				id: generateId(
					"ACCESSES",
					`${sortOwner}->sort-using->${usingFile}:L${sort.line}`,
				),
				type: "ACCESSES",
				sourceId: sortFileId,
				targetId: usingId,
				confidence: 0.85,
				reason: "sort-using",
			});
		}
		for (const givingFile of sort.givingFiles) {
			const givingId = generateId("Record", `${filePath}:${givingFile}`);
			graph.addRelationship({
				id: generateId(
					"ACCESSES",
					`${sortOwner}->sort-giving->${givingFile}:L${sort.line}`,
				),
				type: "ACCESSES",
				sourceId: sortFileId,
				targetId: givingId,
				confidence: 0.85,
				reason: "sort-giving",
			});
		}
	}

	// ── SEARCH -> ACCESSES edges ──────────────────────────────────
	for (const search of extracted.searches) {
		const targetPropId = dataItemMap.get(search.target.toUpperCase());
		if (targetPropId) {
			const searchOwner = owningModuleId(search.line);
			graph.addRelationship({
				id: generateId(
					"ACCESSES",
					`${searchOwner}->search->${search.target}:L${search.line}`,
				),
				type: "ACCESSES",
				sourceId: searchOwner,
				targetId: targetPropId,
				confidence: 0.9,
				reason: "cobol-search",
			});
		}
	}

	// ── CANCEL -> CALLS edges (with two-pass resolution like CALL) ──
	for (const cancel of extracted.cancels) {
		if (!cancel.isQuoted) {
			// Dynamic CANCEL via data item — annotate, don't resolve
			graph.addNode({
				id: generateId(
					"CodeElement",
					`${filePath}:dynamic-cancel:${cancel.target}:L${cancel.line}`,
				),
				label: "CodeElement",
				properties: {
					name: `CANCEL ${cancel.target}`,
					filePath,
					startLine: cancel.line,
					endLine: cancel.line,
					language: SupportedLanguages.Cobol,
					description:
						"dynamic-cancel (target is a data item, not resolvable statically)",
				},
			});
			const cancelOwner = owningModuleId(cancel.line);
			graph.addRelationship({
				id: generateId(
					"CONTAINS",
					`${cancelOwner}->dynamic-cancel:${cancel.target}:L${cancel.line}`,
				),
				type: "CONTAINS",
				sourceId: cancelOwner,
				targetId: generateId(
					"CodeElement",
					`${filePath}:dynamic-cancel:${cancel.target}:L${cancel.line}`,
				),
				confidence: 1.0,
				reason: "cobol-dynamic-cancel",
			});
			continue;
		}
		const targetModuleId = moduleNodeIds.get(cancel.target.toUpperCase());
		const targetId =
			targetModuleId ??
			generateId("Module", `<unresolved>:${cancel.target.toUpperCase()}`);
		const cancelCallOwner = owningModuleId(cancel.line);
		graph.addRelationship({
			id: generateId(
				"CALLS",
				`${cancelCallOwner}->cancel->${cancel.target}:L${cancel.line}`,
			),
			type: "CALLS",
			sourceId: cancelCallOwner,
			targetId,
			confidence: targetModuleId ? 0.9 : 0.5,
			reason: targetModuleId ? "cobol-cancel" : "cobol-cancel-unresolved",
		});
	}

}
