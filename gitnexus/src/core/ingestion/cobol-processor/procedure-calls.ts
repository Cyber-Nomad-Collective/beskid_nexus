import { SupportedLanguages } from "gitnexus-shared";
import { generateId } from "../../../lib/utils.js";
import type { KnowledgeGraph } from "../../graph/types.js";
import type { CobolRegexResults } from "../cobol/cobol-preprocessor.js";
import type { CopyResolution } from "./contracts.js";
import type { CobolGraphLookups } from "./model.js";
import type { ProgramStructureContext } from "./program-structure.js";

export function emitProcedureAndCalls(
	graph: KnowledgeGraph,
	extracted: CobolRegexResults,
	copyResolutions: CopyResolution[],
	moduleNodeIds: Map<string, string>,
	structure: ProgramStructureContext,
	dataItemMap: Map<string, string>,
	lookups: CobolGraphLookups,
): void {
	const {
		filePath,
		lines,
		fileNodeId,
		moduleId,
		programModuleIds,
		parentId,
		sectionNodeIds,
		paraNodeIds,
	} = structure;
	const { scopedParaLookup, scopedCallerLookup, owningModuleId } = lookups;
	// ── PERFORM -> CALLS relationship (intra-file) ──────────────────
	for (const perf of extracted.performs) {
		const targetId = scopedParaLookup(perf.target, perf.line);
		if (!targetId) continue;

		// Source: the paragraph containing the PERFORM, or the module
		const sourceId = scopedCallerLookup(perf.caller, perf.line);

		graph.addRelationship({
			id: generateId("CALLS", `${sourceId}->perform->${targetId}:L${perf.line}`),
			type: "CALLS",
			sourceId,
			targetId,
			confidence: 1.0,
			reason: "cobol-perform",
		});

		// PERFORM THRU -> expanded CALLS edge to thru target
		if (perf.thruTarget) {
			const thruTargetId = scopedParaLookup(perf.thruTarget, perf.line);
			if (thruTargetId && thruTargetId !== targetId) {
				graph.addRelationship({
					id: generateId(
						"CALLS",
						`${sourceId}->perform-thru->${thruTargetId}:L${perf.line}`,
					),
					type: "CALLS",
					sourceId,
					targetId: thruTargetId,
					confidence: 1.0,
					reason: "cobol-perform-thru",
				});
			}
		}
	}

	// ── CALL -> CALLS relationship (cross-program) ──────────────────
	for (const call of extracted.calls) {
		if (!call.isQuoted) {
			// Dynamic CALL via data item — not statically resolvable.
			// Emit a CodeElement annotation for visibility in impact analysis.
			graph.addNode({
				id: generateId(
					"CodeElement",
					`${filePath}:dynamic-call:${call.target}:L${call.line}`,
				),
				label: "CodeElement",
				properties: {
					name: `CALL ${call.target}`,
					filePath,
					startLine: call.line,
					endLine: call.line,
					language: SupportedLanguages.Cobol,
					description:
						"dynamic-call (target is a data item, not resolvable statically)",
				},
			});
			const dynCallOwner = owningModuleId(call.line);
			graph.addRelationship({
				id: generateId(
					"CONTAINS",
					`${dynCallOwner}->dynamic-call:${call.target}:L${call.line}`,
				),
				type: "CONTAINS",
				sourceId: dynCallOwner,
				targetId: generateId(
					"CodeElement",
					`${filePath}:dynamic-call:${call.target}:L${call.line}`,
				),
				confidence: 1.0,
				reason: "cobol-dynamic-call",
			});

			// CALL USING parameters for dynamic call too
			if (call.parameters && call.parameters.length > 0) {
				for (const param of call.parameters) {
					const paramPropId = dataItemMap.get(param.toUpperCase());
					if (paramPropId) {
						graph.addRelationship({
							id: generateId(
								"ACCESSES",
								`${dynCallOwner}->call-using->${param}:L${call.line}`,
							),
							type: "ACCESSES",
							sourceId: dynCallOwner,
							targetId: paramPropId,
							confidence: 0.9,
							reason: "cobol-call-using",
						});
					}
				}
			}
			// CALL RETURNING target for dynamic call too
			if (call.returning) {
				const retPropId = dataItemMap.get(call.returning.toUpperCase());
				if (retPropId) {
					graph.addRelationship({
						id: generateId(
							"ACCESSES",
							`${dynCallOwner}->call-returning->${call.returning}:L${call.line}`,
						),
						type: "ACCESSES",
						sourceId: dynCallOwner,
						targetId: retPropId,
						confidence: 0.9,
						reason: "cobol-call-returning",
					});
				}
			}
			continue;
		}

		const targetModuleId = moduleNodeIds.get(call.target.toUpperCase());
		// Create edge even if target not yet known — use a synthetic target id
		const targetId =
			targetModuleId ??
			generateId("Module", `<unresolved>:${call.target.toUpperCase()}`);

		const callOwner = owningModuleId(call.line);
		graph.addRelationship({
			id: generateId("CALLS", `${callOwner}->call->${call.target}:L${call.line}`),
			type: "CALLS",
			sourceId: callOwner,
			targetId,
			confidence: targetModuleId ? 0.95 : 0.5,
			reason: targetModuleId ? "cobol-call" : "cobol-call-unresolved",
		});

		// CALL USING parameters -> ACCESSES edges (data flow across programs)
		if (call.parameters && call.parameters.length > 0) {
			for (const param of call.parameters) {
				const paramPropId = dataItemMap.get(param.toUpperCase());
				if (paramPropId) {
					graph.addRelationship({
						id: generateId(
							"ACCESSES",
							`${callOwner}->call-using->${param}:L${call.line}`,
						),
						type: "ACCESSES",
						sourceId: callOwner,
						targetId: paramPropId,
						confidence: 0.9,
						reason: "cobol-call-using",
					});
				}
			}
		}
		// CALL RETURNING target -> ACCESSES edge (return value data flow)
		if (call.returning) {
			const retPropId = dataItemMap.get(call.returning.toUpperCase());
			if (retPropId) {
				graph.addRelationship({
					id: generateId(
						"ACCESSES",
						`${callOwner}->call-returning->${call.returning}:L${call.line}`,
					),
					type: "ACCESSES",
					sourceId: callOwner,
					targetId: retPropId,
					confidence: 0.9,
					reason: "cobol-call-returning",
				});
			}
		}
	}

	// ── COPY -> IMPORTS relationship ─────────────────────────────────
	for (const res of copyResolutions) {
		if (!res.resolvedPath) continue;
		const targetFileId = generateId("File", res.resolvedPath);
		graph.addRelationship({
			id: generateId(
				"IMPORTS",
				`${fileNodeId}->${targetFileId}:${res.copyTarget}`,
			),
			type: "IMPORTS",
			sourceId: fileNodeId,
			targetId: targetFileId,
			confidence: 1.0,
			reason: "cobol-copy",
		});
	}

	// ── EXEC SQL blocks -> CodeElement nodes + ACCESSES edges ──────
	for (const sql of extracted.execSqlBlocks) {
		const sqlId = generateId("CodeElement", `${filePath}:exec-sql:L${sql.line}`);
		graph.addNode({
			id: sqlId,
			label: "CodeElement",
			properties: {
				name: `EXEC SQL ${sql.operation}`,
				filePath,
				startLine: sql.line,
				endLine: sql.line,
				language: SupportedLanguages.Cobol,
				description: `tables:[${sql.tables.join(",")}] cursors:[${sql.cursors.join(",")}]`,
			},
		});
		const sqlOwner = owningModuleId(sql.line);
		graph.addRelationship({
			id: generateId("CONTAINS", `${sqlOwner}->${sqlId}`),
			type: "CONTAINS",
			sourceId: sqlOwner,
			targetId: sqlId,
			confidence: 1.0,
			reason: "cobol-exec-sql",
		});
		// ACCESSES edges to tables
		for (const table of sql.tables) {
			const tableId = generateId("Record", `<db>:${table}`);
			graph.addRelationship({
				id: generateId("ACCESSES", `${sqlId}->${tableId}:${sql.operation}`),
				type: "ACCESSES",
				sourceId: sqlId,
				targetId: tableId,
				confidence: 0.9,
				reason: `sql-${sql.operation.toLowerCase()}`,
			});
		}

		// EXEC SQL INCLUDE -> IMPORTS edge
		if (sql.includeMember) {
			// Try to resolve as a copybook
			const includeTarget = sql.includeMember.toUpperCase();
			// We don't have copybookMap here, so emit directly as IMPORTS
			// The edge uses reason 'sql-include' to distinguish from COPY
			graph.addRelationship({
				id: generateId(
					"IMPORTS",
					`${fileNodeId}->sql-include->${includeTarget}:L${sql.line}`,
				),
				type: "IMPORTS",
				sourceId: fileNodeId,
				targetId: generateId("File", `<unresolved>:${includeTarget}`),
				confidence: 0.8,
				reason: "sql-include",
			});
		}
	}

	// ── PROCEDURE DIVISION USING -> ACCESSES edges (parameter contract) ──
	// Iterate per-program to handle nested programs with their own USING clauses
	for (const prog of extracted.programs) {
		const progModId = programModuleIds.get(prog.name.toUpperCase()) ?? moduleId;
		if (progModId && prog.procedureUsing && prog.procedureUsing.length > 0) {
			for (const param of prog.procedureUsing) {
				const paramPropId = dataItemMap.get(param.toUpperCase());
				if (paramPropId) {
					graph.addRelationship({
						id: generateId("ACCESSES", `${progModId}->using->${param}`),
						type: "ACCESSES",
						sourceId: progModId,
						targetId: paramPropId,
						confidence: 1.0,
						reason: "cobol-procedure-using",
					});
				}
			}
		}
	}

	// ── EXEC CICS blocks -> CodeElement nodes + CALLS edges ────────
	for (const cics of extracted.execCicsBlocks) {
		const cicsId = generateId(
			"CodeElement",
			`${filePath}:exec-cics:L${cics.line}`,
		);
		graph.addNode({
			id: cicsId,
			label: "CodeElement",
			properties: {
				name: `EXEC CICS ${cics.command}`,
				filePath,
				startLine: cics.line,
				endLine: cics.line,
				language: SupportedLanguages.Cobol,
				description:
					[
						cics.mapName && `map:${cics.mapName}`,
						cics.programName &&
							`program:${cics.programName}${cics.programIsLiteral === false ? " (dynamic)" : ""}`,
						cics.transId && `transid:${cics.transId}`,
						cics.fileName && `file:${cics.fileName}`,
						cics.queueName && `queue:${cics.queueName}`,
						cics.labelName && `label:${cics.labelName}`,
					]
						.filter(Boolean)
						.join(" ") || undefined,
			},
		});
		const cicsOwner = owningModuleId(cics.line);
		graph.addRelationship({
			id: generateId("CONTAINS", `${cicsOwner}->${cicsId}`),
			type: "CONTAINS",
			sourceId: cicsOwner,
			targetId: cicsId,
			confidence: 1.0,
			reason: "cobol-exec-cics",
		});
		// LINK/XCTL -> cross-program CALLS (handles both literal and variable PROGRAM)
		if (cics.programName && ["LINK", "XCTL", "LOAD"].includes(cics.command)) {
			if (cics.programIsLiteral === false) {
				// Dynamic PROGRAM reference via variable — annotate, don't resolve
				graph.addNode({
					id: generateId(
						"CodeElement",
						`${filePath}:cics-dynamic-pgm:${cics.programName}:L${cics.line}`,
					),
					label: "CodeElement",
					properties: {
						name: `CICS ${cics.command} ${cics.programName}`,
						filePath,
						startLine: cics.line,
						endLine: cics.line,
						language: SupportedLanguages.Cobol,
						description: `cics-dynamic-program (target is data item ${cics.programName})`,
					},
				});
				graph.addRelationship({
					id: generateId(
						"CONTAINS",
						`${cicsOwner}->cics-dynamic-pgm:${cics.programName}:L${cics.line}`,
					),
					type: "CONTAINS",
					sourceId: cicsOwner,
					targetId: generateId(
						"CodeElement",
						`${filePath}:cics-dynamic-pgm:${cics.programName}:L${cics.line}`,
					),
					confidence: 1.0,
					reason: "cics-dynamic-program",
				});
			} else {
				const cicsTargetModuleId = moduleNodeIds.get(
					cics.programName.toUpperCase(),
				);
				const targetId =
					cicsTargetModuleId ??
					generateId("Module", `<unresolved>:${cics.programName.toUpperCase()}`);
				const cicsReason = `cics-${cics.command.toLowerCase()}`;
				graph.addRelationship({
					id: generateId(
						"CALLS",
						`${cicsOwner}->cics-${cics.command.toLowerCase()}->${cics.programName}:L${cics.line}`,
					),
					type: "CALLS",
					sourceId: cicsOwner,
					targetId,
					confidence: cicsTargetModuleId ? 0.95 : 0.5,
					reason: cicsTargetModuleId ? cicsReason : `${cicsReason}-unresolved`,
				});
			}
		}

		// CICS FILE I/O -> ACCESSES edges (READ/WRITE/REWRITE/DELETE/STARTBR/ENDBR FILE)
		if (cics.fileName) {
			const fileRecordId = generateId(
				"Record",
				`<cics-file>:${cics.fileName.toUpperCase()}`,
			);
			const ioCommand = cics.command.toUpperCase();
			const isRead = [
				"READ",
				"STARTBR",
				"READNEXT",
				"READPREV",
				"READ NEXT",
				"READ PREV",
				"ENDBR",
			].includes(ioCommand);
			const isWrite = ["WRITE", "REWRITE", "DELETE"].includes(ioCommand);
			const reason = isRead
				? "cics-file-read"
				: isWrite
					? "cics-file-write"
					: "cics-file-access";
			graph.addRelationship({
				id: generateId(
					"ACCESSES",
					`${cicsId}->file->${cics.fileName}:L${cics.line}`,
				),
				type: "ACCESSES",
				sourceId: cicsId,
				targetId: fileRecordId,
				confidence: 0.9,
				reason,
			});
		}

		// CICS QUEUE -> ACCESSES edge with differentiated reason (WRITEQ/READQ/DELETEQ TS/TD)
		if (cics.queueName) {
			const queueId = generateId("Record", `<queue>:${cics.queueName}`);
			const qCmd = cics.command.toUpperCase();
			const qReason = qCmd.startsWith("READQ")
				? "cics-queue-read"
				: qCmd.startsWith("WRITEQ")
					? "cics-queue-write"
					: qCmd.startsWith("DELETEQ")
						? "cics-queue-delete"
						: "cics-queue";
			graph.addRelationship({
				id: generateId(
					"ACCESSES",
					`${cicsId}->queue->${cics.queueName}:L${cics.line}`,
				),
				type: "ACCESSES",
				sourceId: cicsId,
				targetId: queueId,
				confidence: 0.85,
				reason: qReason,
			});
		}

		// CICS RETURN/START TRANSID -> CALLS edge (transaction flow)
		if (cics.transId) {
			const cmd = cics.command.toUpperCase();
			if (cmd === "RETURN" || cmd.startsWith("START")) {
				const transNodeId = generateId("CodeElement", `<transid>:${cics.transId}`);
				graph.addRelationship({
					id: generateId(
						"CALLS",
						`${cicsOwner}->${cmd === "RETURN" ? "return" : "start"}-transid->${cics.transId}:L${cics.line}`,
					),
					type: "CALLS",
					sourceId: cicsOwner,
					targetId: transNodeId,
					confidence: 0.8,
					reason: cmd === "RETURN" ? "cics-return-transid" : "cics-start-transid",
				});
			}
		}

		// CICS MAP -> ACCESSES edge (screen/mapset traceability)
		if (cics.mapName) {
			const mapId = generateId("Record", `<map>:${cics.mapName}`);
			graph.addRelationship({
				id: generateId("ACCESSES", `${cicsId}->map->${cics.mapName}:L${cics.line}`),
				type: "ACCESSES",
				sourceId: cicsId,
				targetId: mapId,
				confidence: 0.85,
				reason: "cics-map",
			});
		}

		// CICS INTO(data-area) -> ACCESSES edge (data write target)
		if (cics.intoField) {
			const intoPropId = dataItemMap.get(cics.intoField.toUpperCase());
			if (intoPropId) {
				graph.addRelationship({
					id: generateId(
						"ACCESSES",
						`${cicsId}->into->${cics.intoField}:L${cics.line}`,
					),
					type: "ACCESSES",
					sourceId: cicsId,
					targetId: intoPropId,
					confidence: 0.9,
					reason: "cics-receive-into",
				});
			}
		}

		// CICS FROM(data-area) -> ACCESSES edge (data read source)
		if (cics.fromField) {
			const fromPropId = dataItemMap.get(cics.fromField.toUpperCase());
			if (fromPropId) {
				graph.addRelationship({
					id: generateId(
						"ACCESSES",
						`${cicsId}->from->${cics.fromField}:L${cics.line}`,
					),
					type: "ACCESSES",
					sourceId: cicsId,
					targetId: fromPropId,
					confidence: 0.9,
					reason: "cics-send-from",
				});
			}
		}

		// CICS HANDLE ABEND LABEL -> CALLS edge to error handler paragraph
		if (cics.labelName) {
			const labelTargetId = scopedParaLookup(cics.labelName, cics.line);
			if (labelTargetId) {
				graph.addRelationship({
					id: generateId(
						"CALLS",
						`${cicsOwner}->abend-label->${cics.labelName}:L${cics.line}`,
					),
					type: "CALLS",
					sourceId: cicsOwner,
					targetId: labelTargetId,
					confidence: 0.9,
					reason: "cics-handle-abend",
				});
			}
		}
	}

	// ── ENTRY points -> Constructor nodes ──────────────────────────
	for (const entry of extracted.entryPoints) {
		const entryId = generateId("Constructor", `${filePath}:${entry.name}`);
		graph.addNode({
			id: entryId,
			label: "Constructor",
			properties: {
				name: entry.name,
				filePath,
				startLine: entry.line,
				endLine: entry.line,
				language: SupportedLanguages.Cobol,
				isExported: true,
				description:
					entry.parameters.length > 0
						? `using:${entry.parameters.join(",")}`
						: undefined,
			},
		});
		const entryOwner = owningModuleId(entry.line);
		graph.addRelationship({
			id: generateId("CONTAINS", `${entryOwner}->${entryId}`),
			type: "CONTAINS",
			sourceId: entryOwner,
			targetId: entryId,
			confidence: 1.0,
			reason: "cobol-entry-point",
		});
		// Register in moduleNodeIds for cross-program resolution
		moduleNodeIds.set(entry.name.toUpperCase(), entryId);
	}

}
