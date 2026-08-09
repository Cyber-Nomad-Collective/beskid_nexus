import type { CobolRegexResults } from "./contracts.js";
import type { Division, DataSection, EnvironmentSection } from "./scanner.js";
import {
	USING_KEYWORDS,
	CALL_USING_FILTER,
	EXCLUDED_PARA_NAMES,
	RE_PROGRAM_ID,
	RE_AUTHOR,
	RE_DATE_WRITTEN,
	RE_DATE_COMPILED,
	RE_INSTALLATION,
	RE_SELECT_START,
	RE_FD,
	RE_DATA_ITEM,
	RE_ANONYMOUS_REDEFINES,
	RE_88_LEVEL,
	RE_PROC_SECTION,
	RE_PROC_PARAGRAPH,
	RE_PERFORM,
	RE_CALL,
	RE_CALL_DYNAMIC,
	RE_GOTO,
	RE_SORT,
	RE_MERGE,
	RE_SEARCH,
	RE_CANCEL,
	RE_CANCEL_DYNAMIC,
	RE_66_LEVEL,
	RE_USE_AFTER,
	RE_SET_TO_TRUE,
	RE_SET_INDEX,
	RE_INITIALIZE,
	INITIALIZE_CLAUSE_KEYWORDS,
	RE_ENTRY,
	RE_MOVE,
	MOVE_SKIP,
	extractMoveTargets,
	PERFORM_KEYWORD_SKIP,
	SORT_CLAUSE_NOISE,
	RE_STATEMENT_VERB_START,
	RE_USING_PARAMS,
} from "./scanner.js";
import {
	parseDataItemClauses,
	parseConditionValues,
	parseSelectStatement,
} from "./parsers.js";

export interface CobolExtractionState {
	result: CobolRegexResults;
	currentDivision: Division;
	currentDataSection: DataSection;
	currentEnvSection: EnvironmentSection;
	currentParagraph: string | null;
	programBoundaryStack: Array<{
		name: string;
		startLine: number;
		procedureUsing?: string[];
		isCommon?: boolean;
	}>;
	selectAccum: string | null;
	selectStartLine: number;
	pendingProcUsing: boolean;
	sortAccum: string | null;
	sortStartLine: number;
	execAccum: {
		type: "sql" | "cics" | "dli";
		lines: string;
		startLine: number;
	} | null;
	inDeclaratives: boolean;
	inspectAccum: string | null;
	inspectStartLine: number;
	callAccum: string | null;
	callAccumLine: number;
	pendingFdName: string | null;
	pendingFdLine: number;
	pendingLine: string | null;
	pendingLineNumber: number;
	isFreeFormat: boolean;
}

export function createExtractionHandlers(state: CobolExtractionState) {
	function extractIdentification(line: string, lineNum: number): void {
		const m = line.match(RE_PROGRAM_ID);
		if (m) {
			if (state.result.programName === null) {
				state.result.programName = m[1];
			}

			// Reset state machine for new program (nested or sibling)
			state.currentDivision = "identification";
			state.currentDataSection = "unknown";
			state.currentEnvSection = null;
			state.currentParagraph = null;

			// Detect COMMON attribute
			const isCommon = /\bIS\s+COMMON\b/i.test(line);

			// Push program boundary for line-range tracking
			state.programBoundaryStack.push({
				name: m[1],
				startLine: lineNum,
				isCommon: isCommon || undefined,
			});
			return;
		}

		const authorMatch = line.match(RE_AUTHOR);
		if (authorMatch) {
			state.result.programMetadata.author = authorMatch[1]
				.replace(/\.\s*$/, "")
				.trim();
			return;
		}

		const dateMatch = line.match(RE_DATE_WRITTEN);
		if (dateMatch) {
			state.result.programMetadata.dateWritten = dateMatch[1]
				.replace(/\.\s*$/, "")
				.trim();
			return;
		}

		const compMatch = line.match(RE_DATE_COMPILED);
		if (compMatch) {
			state.result.programMetadata.dateCompiled = compMatch[1]
				.replace(/\.\s*$/, "")
				.trim();
			return;
		}
		const instMatch = line.match(RE_INSTALLATION);
		if (instMatch) {
			state.result.programMetadata.installation = instMatch[1]
				.replace(/\.\s*$/, "")
				.trim();
		}
	}

	// =========================================================================
	// ENVIRONMENT DIVISION extraction
	// =========================================================================
	function extractEnvironment(line: string, lineNum: number): void {
		if (state.currentEnvSection !== "input-output") return;

		// Check for new SELECT statement
		const selMatch = line.match(RE_SELECT_START);
		if (selMatch) {
			// Flush any previous SELECT
			flushSelect();
			state.selectAccum = line.trim();
			state.selectStartLine = lineNum;
		} else if (state.selectAccum !== null) {
			// Accumulate continuation of current SELECT
			state.selectAccum += ` ${line.trim()}`;
		}

		// Check if current SELECT is terminated (ends with period)
		if (state.selectAccum !== null && /\.\s*$/.test(state.selectAccum)) {
			flushSelect();
		}
	}

	function flushSelect(): void {
		if (state.selectAccum === null) return;
		const decl = parseSelectStatement(state.selectAccum, state.selectStartLine);
		if (decl) {
			state.result.fileDeclarations.push(decl);
		}
		state.selectAccum = null;
	}

	function flushSort(): void {
		if (state.sortAccum === null) return;
		const fullSort = state.sortAccum;
		const smatch = fullSort.match(RE_SORT) || fullSort.match(RE_MERGE);
		if (smatch) {
			const upper = fullSort.toUpperCase();
			const usingIdx = upper.search(/\bUSING\s/);
			const givingIdx = upper.search(/\bGIVING\s/);
			const usingFiles: string[] = [];
			const givingFiles: string[] = [];
			if (usingIdx >= 0) {
				const afterUsing = fullSort.substring(usingIdx + 6);
				const gIdx = afterUsing.toUpperCase().search(/\bGIVING\b/);
				const usingText = gIdx >= 0 ? afterUsing.substring(0, gIdx) : afterUsing;
				usingFiles.push(
					...usingText
						.trim()
						.split(/\s+/)
						.map((f) => f.replace(/\.$/, ""))
						.filter(
							(f) =>
								/^[A-Z][A-Z0-9-]+$/i.test(f) && !SORT_CLAUSE_NOISE.has(f.toUpperCase()),
						),
				);
			}
			if (givingIdx >= 0) {
				const givingText = fullSort.substring(givingIdx + 7);
				givingFiles.push(
					...givingText
						.trim()
						.split(/\s+/)
						.map((f) => f.replace(/\.$/, ""))
						.filter(
							(f) =>
								/^[A-Z][A-Z0-9-]+$/i.test(f) && !SORT_CLAUSE_NOISE.has(f.toUpperCase()),
						),
				);
			}
			// INPUT PROCEDURE IS / OUTPUT PROCEDURE IS → control-flow targets (like PERFORM)
			// Supports optional THRU/THROUGH range: INPUT PROCEDURE IS proc-start THRU proc-end
			const inputProcMatch = fullSort.match(
				/\bINPUT\s+PROCEDURE\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)(?:\s+(?:THRU|THROUGH)\s+([A-Z][A-Z0-9-]+))?/i,
			);
			const outputProcMatch = fullSort.match(
				/\bOUTPUT\s+PROCEDURE\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)(?:\s+(?:THRU|THROUGH)\s+([A-Z][A-Z0-9-]+))?/i,
			);
			if (inputProcMatch) {
				state.result.performs.push({
					caller: state.currentParagraph,
					target: inputProcMatch[1],
					thruTarget: inputProcMatch[2] || undefined,
					line: state.sortStartLine,
				});
			}
			if (outputProcMatch) {
				state.result.performs.push({
					caller: state.currentParagraph,
					target: outputProcMatch[1],
					thruTarget: outputProcMatch[2] || undefined,
					line: state.sortStartLine,
				});
			}
			state.result.sorts.push({
				sortFile: smatch[1],
				usingFiles,
				givingFiles,
				line: state.sortStartLine,
			});
		}
		state.sortAccum = null;
	}

	function flushInspect(): void {
		if (state.inspectAccum === null) return;
		const text = state.inspectAccum;
		const fieldMatch = text.match(/\bINSPECT\s+([A-Z][A-Z0-9-]+)/i);
		if (!fieldMatch) {
			state.inspectAccum = null;
			return;
		}

		const counters: string[] = [];
		const tallySection = text.match(
			/\bTALLYING\b([\s\S]+?)(?:\bREPLACING\b|\bCONVERTING\b|\.\s*$)/i,
		);
		if (tallySection) {
			const counterRe = /([A-Z][A-Z0-9-]+)\s+FOR\b/gi;
			let cm: RegExpExecArray | null;
			while ((cm = counterRe.exec(tallySection[1])) !== null) {
				counters.push(cm[1]);
			}
		}

		const hasTallying = /\bTALLYING\b/i.test(text);
		const hasReplacing = /\bREPLACING\b/i.test(text);
		const hasConverting = /\bCONVERTING\b/i.test(text);
		const form = hasConverting
			? ("converting" as const)
			: hasTallying && hasReplacing
				? ("tallying-replacing" as const)
				: hasTallying
					? ("tallying" as const)
					: ("replacing" as const);

		state.result.inspects.push({
			inspectedField: fieldMatch[1],
			counters,
			form,
			line: state.inspectStartLine,
			caller: state.currentParagraph,
		});
		state.inspectAccum = null;
	}

	/**
	 * Flush accumulated multi-line CALL statement. Re-extracts CALL target
	 * and USING parameters from the full accumulated text.
	 */
	function flushCallAccum(): void {
		if (state.callAccum === null) return;
		const text = state.callAccum;

		// Extract quoted CALLs from the full statement
		for (const callMatch of text.matchAll(RE_CALL)) {
			const callTarget = callMatch[1] ?? callMatch[2];
			const afterCall = text.substring(callMatch.index! + callMatch[0].length);
			const usingMatch = afterCall.match(RE_USING_PARAMS);
			const parameters = usingMatch
				? usingMatch[1]
						.split(/\bRETURNING\b/i)[0]
						.trim()
						.split(/\s+/)
						.filter(
							(s) =>
								s.length > 0 &&
								!CALL_USING_FILTER.has(s.toUpperCase()) &&
								/^[A-Z][A-Z0-9-]+$/i.test(s),
						)
				: undefined;
			const retMatch = afterCall.match(/\bRETURNING\s+([A-Z][A-Z0-9-]+)/i);
			const returning = retMatch ? retMatch[1] : undefined;
			state.result.calls.push({
				target: callTarget,
				line: state.callAccumLine,
				isQuoted: true,
				parameters,
				returning,
			});
		}

		// Extract dynamic CALLs from the full statement
		for (const dynCallMatch of text.matchAll(RE_CALL_DYNAMIC)) {
			const afterDynCall = text.substring(
				dynCallMatch.index! + dynCallMatch[0].length,
			);
			const dynUsingMatch = afterDynCall.match(RE_USING_PARAMS);
			const dynParameters = dynUsingMatch
				? dynUsingMatch[1]
						.split(/\bRETURNING\b/i)[0]
						.trim()
						.split(/\s+/)
						.filter(
							(s) =>
								s.length > 0 &&
								!CALL_USING_FILTER.has(s.toUpperCase()) &&
								/^[A-Z][A-Z0-9-]+$/i.test(s),
						)
				: undefined;
			const dynRetMatch = afterDynCall.match(/\bRETURNING\s+([A-Z][A-Z0-9-]+)/i);
			const dynReturning = dynRetMatch ? dynRetMatch[1] : undefined;
			state.result.calls.push({
				target: dynCallMatch[1],
				line: state.callAccumLine,
				isQuoted: false,
				parameters: dynParameters,
				returning: dynReturning,
			});
		}

		// Extract CANCELs from within the CALL block (common in ON EXCEPTION handlers)
		for (const cancelMatch of text.matchAll(RE_CANCEL)) {
			state.result.cancels.push({
				target: cancelMatch[1] ?? cancelMatch[2],
				line: state.callAccumLine,
				isQuoted: true,
			});
		}
		for (const dynCancelMatch of text.matchAll(RE_CANCEL_DYNAMIC)) {
			state.result.cancels.push({
				target: dynCancelMatch[1],
				line: state.callAccumLine,
				isQuoted: false,
			});
		}

		state.callAccum = null;
	}

	// =========================================================================
	// DATA DIVISION extraction
	// =========================================================================
	function extractData(line: string, lineNum: number): void {
		// FD entry
		const fdMatch = line.match(RE_FD);
		if (fdMatch) {
			// Flush any previous FD without a record
			if (state.pendingFdName !== null) {
				state.result.fdEntries.push({
					fdName: state.pendingFdName,
					line: state.pendingFdLine,
				});
			}
			state.pendingFdName = fdMatch[1];
			state.pendingFdLine = lineNum;
			return;
		}

		// 88-level condition names
		const lv88Match = line.match(RE_88_LEVEL);
		if (lv88Match) {
			const name = lv88Match[1];
			const values = parseConditionValues(lv88Match[2]);
			state.result.dataItems.push({
				name,
				level: 88,
				line: lineNum,
				values,
				section: state.currentDataSection,
			});
			return;
		}

		// Level 66 RENAMES
		const lv66Match = line.match(RE_66_LEVEL);
		if (lv66Match) {
			state.result.dataItems.push({
				name: lv66Match[1],
				level: 66,
				line: lineNum,
				redefines: lv66Match[2], // RENAMES target stored as redefines
				section: state.currentDataSection,
			});
			return;
		}

		// Anonymous REDEFINES (no name, e.g. "01 REDEFINES WK-PERIVAL.")
		const anonRedefMatch = line.match(RE_ANONYMOUS_REDEFINES);
		if (anonRedefMatch) {
			// Check it's truly anonymous: the second capture is not a valid data name
			// followed by more clauses — it's the REDEFINES target directly after level
			const _level = parseInt(anonRedefMatch[1], 10);
			// Only skip if this is genuinely "NN REDEFINES target" with no name between
			// We detect this by checking the full data item regex does NOT match
			// (because RE_DATA_ITEM expects a name before any clauses)
			const dataMatch = line.match(RE_DATA_ITEM);
			if (!dataMatch || dataMatch[2].toUpperCase() === "REDEFINES") {
				// Truly anonymous — skip, no node
				return;
			}
		}

		// Standard data items: level 01-49, 66, 77
		const dataMatch = line.match(RE_DATA_ITEM);
		if (dataMatch) {
			const level = parseInt(dataMatch[1], 10);
			const name = dataMatch[2];
			const rest = dataMatch[3] || "";

			// Skip FILLER
			if (name.toUpperCase() === "FILLER") return;

			// Valid levels: 01-49, 66, 77
			if ((level >= 1 && level <= 49) || level === 66 || level === 77) {
				const clauses = parseDataItemClauses(rest);

				const item: CobolRegexResults["dataItems"][number] = {
					name,
					level,
					line: lineNum,
					section: state.currentDataSection,
				};
				if (clauses.pic) item.pic = clauses.pic;
				if (clauses.usage) item.usage = clauses.usage;
				if (clauses.occurs !== undefined) item.occurs = clauses.occurs;
				if (clauses.dependingOn) item.dependingOn = clauses.dependingOn;
				if (clauses.redefines) item.redefines = clauses.redefines;
				if (clauses.value) item.values = [clauses.value];
				if (clauses.isExternal) item.isExternal = true;
				if (clauses.isGlobal) item.isGlobal = true;

				state.result.dataItems.push(item);

				// If there's a pending FD and this is a 01-level, it's the FD's record
				if (state.pendingFdName !== null && level === 1) {
					state.result.fdEntries.push({
						fdName: state.pendingFdName,
						recordName: name,
						line: state.pendingFdLine,
					});
					state.pendingFdName = null;
				}
			}
		}
	}

	// =========================================================================
	// PROCEDURE DIVISION extraction
	// =========================================================================
	function extractProcedure(line: string, lineNum: number): void {
		// USE AFTER EXCEPTION in DECLARATIVES
		if (state.inDeclaratives) {
			const useMatch = line.match(RE_USE_AFTER);
			if (useMatch) {
				// Find the most recent section name
				const lastSection = state.result.sections[state.result.sections.length - 1];
				if (lastSection) {
					state.result.declaratives.push({
						sectionName: lastSection.name,
						target: useMatch[1],
						line: lineNum,
					});
				}
				return;
			}
		}

		// Handle PROCEDURE DIVISION USING on a continuation line
		if (state.pendingProcUsing) {
			const usingMatch = line.match(/\bUSING\s+([\s\S]*?)(?:\.|$)/i);
			if (usingMatch) {
				const params = usingMatch[1]
					.split(/\bRETURNING\b/i)[0]
					.trim()
					.split(/\s+/)
					.filter((s) => s.length > 0 && !USING_KEYWORDS.has(s.toUpperCase()));
				state.result.procedureUsing = params;
				const topProg =
					state.programBoundaryStack[state.programBoundaryStack.length - 1];
				if (topProg) topProg.procedureUsing = params;
			}
			state.pendingProcUsing = false;
			if (usingMatch) return; // consumed the USING line
		}

		// Section header
		const secMatch = line.match(RE_PROC_SECTION);
		if (secMatch) {
			const name = secMatch[1];
			if (
				!EXCLUDED_PARA_NAMES.has(name.toUpperCase()) &&
				!name.toUpperCase().includes("DIVISION")
			) {
				state.result.sections.push({ name, line: lineNum });
				// Don't set state.currentParagraph to section name — sections are Namespaces,
				// not Functions. Setting it here would cause PERFORMs to be attributed
				// to the section instead of the containing paragraph.
			}
			return;
		}

		// Paragraph header
		const paraMatch = line.match(RE_PROC_PARAGRAPH);
		if (paraMatch) {
			const name = paraMatch[1];
			// In fixed-format, paragraphs must start in Area A (col 8-11, max 7 leading spaces).
			// Reject deeply-indented lines (Area B, 8+ spaces) to prevent false paragraphs from
			// data items or CALL USING parameters on continuation lines.
			const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
			if (!state.isFreeFormat && leadingSpaces > 7) return; // Area B — not a paragraph
			if (
				!EXCLUDED_PARA_NAMES.has(name.toUpperCase()) &&
				!name.toUpperCase().startsWith("END-") &&
				name.toUpperCase() !== "DIVISION" &&
				name.toUpperCase() !== "SECTION"
			) {
				state.result.paragraphs.push({ name, line: lineNum });
				state.currentParagraph = name;
			}
			return;
		}

		// PERFORM (global — captures multiple PERFORMs on the same logical line)
		for (const perfMatch of line.matchAll(RE_PERFORM)) {
			const target = perfMatch[1];
			// Skip COBOL inline-perform keywords that are not paragraph names
			if (!PERFORM_KEYWORD_SKIP.has(target.toUpperCase())) {
				// Also check for "PERFORM identifier TIMES" — the identifier is a
				// data item count, not a paragraph name (fundamental regex ambiguity).
				const matchEnd = perfMatch.index! + perfMatch[0].length;
				const afterTarget = line.substring(matchEnd).trim();
				if (!/^TIMES\b/i.test(afterTarget)) {
					state.result.performs.push({
						caller: state.currentParagraph,
						target,
						thruTarget: perfMatch[2] || undefined,
						line: lineNum,
					});
				}
			}
		}

		// ENTRY point
		const entryMatch = line.match(RE_ENTRY);
		if (entryMatch) {
			const entryName = entryMatch[1] ?? entryMatch[2];
			const usingClause = entryMatch[3];
			if (entryName) {
				state.result.entryPoints.push({
					name: entryName,
					parameters: usingClause
						? usingClause
								.trim()
								.split(/\s+/)
								.filter((s) => s.length > 0 && !USING_KEYWORDS.has(s.toUpperCase()))
						: [],
					line: lineNum,
				});
			}
		}

		// MOVE statement (skip literals and figurative constants)
		const moveMatch = line.match(RE_MOVE);
		if (moveMatch) {
			const from = moveMatch[2].toUpperCase();
			if (!MOVE_SKIP.has(from)) {
				const isCorresponding = !!moveMatch[1];
				// MOVE CORRESPONDING is always single-target per COBOL standard
				const targets = isCorresponding
					? [moveMatch[3].replace(/\..*$/, "").trim().split(/\s+/)[0]].filter((t) =>
							/^[A-Z][A-Z0-9-]+$/i.test(t),
						)
					: extractMoveTargets(moveMatch[3]);

				if (targets.length > 0) {
					state.result.moves.push({
						from: moveMatch[2],
						targets,
						line: lineNum,
						caller: state.currentParagraph,
						corresponding: isCorresponding,
					});
				}
			}
		}

		// GO TO — control flow transfer (handles GO TO p1 p2 p3 DEPENDING ON x)
		const gotoMatch = line.match(RE_GOTO);
		if (gotoMatch) {
			const targets = gotoMatch[1]
				.trim()
				.split(/\s+/)
				.filter((t) => /^[A-Z][A-Z0-9-]+$/i.test(t));
			for (const target of targets) {
				state.result.gotos.push({
					caller: state.currentParagraph,
					target,
					line: lineNum,
				});
			}
		}

		// SORT / MERGE file references (multi-line: accumulate until period)
		if (state.sortAccum !== null) {
			// Continue accumulating SORT/MERGE statement
			state.sortAccum += ` ${line}`;
			if (!/\.\s*$/.test(state.sortAccum)) return; // still accumulating — skip other extractors
			// Period found — flush, then re-check line for a new SORT/MERGE after the period
			flushSort();
			// After flushing, fall through to check if this line also starts a new SORT/MERGE
		}
		const sortMatch = line.match(RE_SORT) || line.match(RE_MERGE);
		if (sortMatch && state.sortAccum === null) {
			state.sortAccum = line;
			state.sortStartLine = lineNum;
			if (!/\.\s*$/.test(state.sortAccum)) return; // multi-line — wait for period
			flushSort();
		}

		// INSPECT — multi-line accumulator (like SORT)
		// If a real paragraph/section header or statement verb arrives during accumulation,
		// flush the INSPECT as-is and process the line normally.
		if (state.inspectAccum !== null) {
			const inspTrimmed = line.trimStart();
			const inspLeading = line.match(/^(\s*)/)?.[1].length ?? 0;
			const inspIsAreaAPara =
				RE_PROC_PARAGRAPH.test(line) &&
				(!state.isFreeFormat ? inspLeading <= 7 : false);
			if (
				RE_PROC_SECTION.test(line) ||
				inspIsAreaAPara ||
				RE_STATEMENT_VERB_START.test(inspTrimmed) ||
				/^CALL(?:\s|$)/i.test(inspTrimmed)
			) {
				flushInspect();
				// Fall through to process this line normally
			} else {
				state.inspectAccum += ` ${line}`;
				if (/\.\s*$/.test(state.inspectAccum)) {
					flushInspect();
				} else {
					return;
				}
			}
		}
		const inspectMatch = line.match(/\bINSPECT\s+([A-Z][A-Z0-9-]+)/i);
		if (inspectMatch && state.inspectAccum === null) {
			state.inspectAccum = line;
			state.inspectStartLine = lineNum;
			if (!/\.\s*$/.test(state.inspectAccum)) return;
			flushInspect();
		}

		// SEARCH — table access
		const searchMatch = line.match(RE_SEARCH);
		if (searchMatch) {
			state.result.searches.push({ target: searchMatch[1], line: lineNum });
		}

		// CANCEL — program lifecycle (global matchAll captures multiple CANCELs on same line)
		for (const cancelMatch of line.matchAll(RE_CANCEL)) {
			state.result.cancels.push({
				target: cancelMatch[1] ?? cancelMatch[2],
				line: lineNum,
				isQuoted: true,
			});
		}
		// Dynamic CANCEL — RE_CANCEL_DYNAMIC cannot match quoted targets, no dedup guard needed
		for (const dynCancelMatch of line.matchAll(RE_CANCEL_DYNAMIC)) {
			state.result.cancels.push({
				target: dynCancelMatch[1],
				line: lineNum,
				isQuoted: false,
			});
		}

		// SET statement (condition, index)
		const setTrueMatch = line.match(RE_SET_TO_TRUE);
		if (setTrueMatch) {
			const targets = setTrueMatch[1]
				.trim()
				.split(/\s+/)
				.filter((t) => /^[A-Z][A-Z0-9-]+$/i.test(t) && t.toUpperCase() !== "OF");
			if (targets.length > 0) {
				state.result.sets.push({
					targets,
					form: "to-true",
					line: lineNum,
					caller: state.currentParagraph,
				});
			}
		} else {
			const setIdxMatch = line.match(RE_SET_INDEX);
			if (setIdxMatch) {
				const targets = setIdxMatch[1]
					.trim()
					.split(/\s+/)
					.filter((t) => /^[A-Z][A-Z0-9-]+$/i.test(t));
				const mode = setIdxMatch[2].toUpperCase();
				const form =
					mode === "TO"
						? ("to-value" as const)
						: mode.startsWith("UP")
							? ("up-by" as const)
							: ("down-by" as const);
				state.result.sets.push({
					targets,
					form,
					value: setIdxMatch[3],
					line: lineNum,
					caller: state.currentParagraph,
				});
			}
		}

		// INITIALIZE — data reset (multi-target: INITIALIZE WS-A WS-B WS-C.)
		const initMatch = line.match(RE_INITIALIZE);
		if (initMatch) {
			const targets = initMatch[1]
				.trim()
				.split(/\s+/)
				.filter(
					(t) =>
						/^[A-Z][A-Z0-9-]+$/i.test(t) &&
						!INITIALIZE_CLAUSE_KEYWORDS.has(t.toUpperCase()),
				);
			for (const target of targets) {
				state.result.initializes.push({
					target,
					line: lineNum,
					caller: state.currentParagraph,
				});
			}
		}
	}

	return {
		extractData,
		extractEnvironment,
		extractIdentification,
		extractProcedure,
		flushCallAccum,
		flushInspect,
		flushSelect,
		flushSort,
	};
}
