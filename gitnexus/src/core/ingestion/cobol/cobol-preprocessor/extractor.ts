import type { CobolRegexResults } from "./contracts.js";
import {
	createExtractionHandlers,
	type CobolExtractionState,
} from "./handlers.js";
import {
	USING_KEYWORDS,
	RE_DIVISION,
	RE_SECTION,
	RE_PROGRAM_ID,
	RE_END_PROGRAM,
	RE_PROC_SECTION,
	RE_PROC_PARAGRAPH,
	RE_COPY_UNQUOTED,
	RE_COPY_QUOTED,
	RE_EXEC_SQL_START,
	RE_EXEC_CICS_START,
	RE_END_EXEC,
	RE_DECLARATIVES_START,
	RE_DECLARATIVES_END,
	RE_EXEC_DLI_START,
	RE_PROC_USING,
	RE_STATEMENT_VERB_START,
	stripInlineComment,
} from "./scanner.js";
import {
	parseExecSqlBlock,
	parseExecCicsBlock,
	parseExecDliBlock,
} from "./parsers.js";

// ---------------------------------------------------------------------------
// Main extraction: single-pass state machine
// ---------------------------------------------------------------------------

/**
 * Extract COBOL symbols using a single-pass state machine.
 * Extracts program name, paragraphs, sections, CALL, PERFORM, COPY,
 * data items, file declarations, FD entries, and program metadata.
 */
export function extractCobolSymbolsWithRegex(
	content: string,
	_filePath: string,
): CobolRegexResults {
	const rawLines = content.split(/\r?\n/);

	const result: CobolRegexResults = {
		programName: null,
		programs: [],
		paragraphs: [],
		sections: [],
		performs: [],
		calls: [],
		copies: [],
		dataItems: [],
		fileDeclarations: [],
		fdEntries: [],
		programMetadata: {},
		execSqlBlocks: [],
		execCicsBlocks: [],
		procedureUsing: [],
		entryPoints: [],
		moves: [],
		gotos: [],
		sorts: [],
		searches: [],
		cancels: [],
		execDliBlocks: [],
		declaratives: [],
		sets: [],
		inspects: [],
		initializes: [],
	};

	// --- State ---
	const state: CobolExtractionState = {
		result,
		currentDivision: null,
		currentDataSection: "unknown",
		currentEnvSection: null,
		currentParagraph: null,
		programBoundaryStack: [],
		selectAccum: null,
		selectStartLine: 0,
		pendingProcUsing: false,
		sortAccum: null,
		sortStartLine: 0,
		execAccum: null,
		inDeclaratives: false,
		inspectAccum: null,
		inspectStartLine: 0,
		callAccum: null,
		callAccumLine: 0,
		pendingFdName: null,
		pendingFdLine: 0,
		pendingLine: null,
		pendingLineNumber: 0,
		isFreeFormat: false,
	};

	// --- Detect source format: free vs fixed ---
	// GnuCOBOL uses >>SOURCE FREE directive, typically in first 5 lines
	for (let i = 0; i < Math.min(rawLines.length, 10); i++) {
		if (/>>SOURCE\s+(?:FORMAT\s+(?:IS\s+)?)?FREE/i.test(rawLines[i])) {
			state.isFreeFormat = true;
			break;
		}
	}

	const {
		extractData,
		extractEnvironment,
		extractIdentification,
		extractProcedure,
		flushCallAccum,
		flushInspect,
		flushSelect,
		flushSort,
	} = createExtractionHandlers(state);

	// --- Process each raw line ---
	for (let i = 0; i < rawLines.length; i++) {
		const raw = rawLines[i];

		if (state.isFreeFormat) {
			// FREE FORMAT: no column-position rules
			// Skip >>SOURCE directive lines
			if (/^[ \t]*>>/.test(raw)) continue;
			// Skip free-format comment lines (*> at start of content)
			const trimmed = raw.trimStart();
			if (trimmed.startsWith("*>") || trimmed.length === 0) continue;
			// Strip inline *> comments (quote-aware)
			let commentIdx = -1;
			let ffInQuote: string | null = null;
			for (let ci = 0; ci < raw.length - 1; ci++) {
				const c = raw[ci];
				if (ffInQuote) {
					if (c === ffInQuote) ffInQuote = null;
				} else if (c === '"' || c === "'") {
					ffInQuote = c;
				} else if (c === "*" && raw[ci + 1] === ">") {
					commentIdx = ci;
					break;
				}
			}
			const line = commentIdx >= 0 ? raw.substring(0, commentIdx) : raw;
			// Free-format lines are logical lines (no continuation indicator)
			const lineNum = i + 1;
			processLogicalLine(line.trim(), lineNum);
			continue;
		}

		// FIXED FORMAT: column-position-based processing

		// Skip lines too short to have indicator area
		if (raw.length < 7) {
			// If there's a pending continuation, flush it
			if (state.pendingLine !== null) {
				processLogicalLine(state.pendingLine, state.pendingLineNumber);
				state.pendingLine = null;
			}
			continue;
		}

		const indicator = raw[6];

		// Comment line: indicator is '*' or '/'
		if (indicator === "*" || indicator === "/") {
			continue;
		}

		// Continuation line: indicator is '-'
		if (indicator === "-") {
			if (state.pendingLine !== null) {
				const continuation = raw.substring(7).trimStart();
				// Handle literal continuation: if continuation starts with a quote,
				// remove the trailing quote from the predecessor and skip the opening quote
				if (
					continuation.length > 0 &&
					(continuation[0] === '"' || continuation[0] === "'")
				) {
					const quoteChar = continuation[0];
					const lastQuoteIdx = state.pendingLine.lastIndexOf(quoteChar);
					if (lastQuoteIdx >= 0) {
						state.pendingLine =
							state.pendingLine.substring(0, lastQuoteIdx) + continuation.substring(1);
					} else {
						state.pendingLine += continuation;
					}
				} else {
					state.pendingLine += continuation;
				}
			}
			continue;
		}

		// Normal line — flush any pending continuation first
		if (state.pendingLine !== null) {
			processLogicalLine(state.pendingLine, state.pendingLineNumber);
			state.pendingLine = null;
		}

		// Strip inline Italian comments, then use area A+B (from col 7 onwards,
		// but keep full line for indentation-sensitive paragraph/section detection)
		const cleaned = stripInlineComment(raw);

		// Buffer as new pending logical line
		state.pendingLine = cleaned;
		state.pendingLineNumber = i + 1; // 1-indexed (consistent with free-format)
	}

	// Flush final pending line
	if (state.pendingLine !== null) {
		processLogicalLine(state.pendingLine, state.pendingLineNumber);
	}

	// Flush any pending SELECT
	flushSelect();

	// Flush any pending SORT/MERGE accumulator (truncated file without trailing period)
	flushSort();

	// Flush any pending INSPECT accumulator (truncated file without trailing period)
	flushInspect();

	// Flush any pending CALL accumulator (truncated file without trailing period)
	flushCallAccum();

	// Flush any pending EXEC block (truncated file without END-EXEC)
	if (state.execAccum !== null) {
		if (state.execAccum.type === "sql") {
			state.result.execSqlBlocks.push(
				parseExecSqlBlock(state.execAccum.lines, state.execAccum.startLine),
			);
		} else if (state.execAccum.type === "cics") {
			state.result.execCicsBlocks.push(
				parseExecCicsBlock(state.execAccum.lines, state.execAccum.startLine),
			);
		} else if (state.execAccum.type === "dli") {
			state.result.execDliBlocks.push(
				parseExecDliBlock(state.execAccum.lines, state.execAccum.startLine),
			);
		}
		state.execAccum = null;
	}

	// If we saw an FD but never found its record, emit it without a record name
	if (state.pendingFdName !== null) {
		state.result.fdEntries.push({
			fdName: state.pendingFdName,
			line: state.pendingFdLine,
		});
		state.pendingFdName = null;
	}

	// Finalize any remaining programs on the boundary stack (e.g., single-program
	// files without END PROGRAM, or outermost programs in nested files)
	while (state.programBoundaryStack.length > 0) {
		const topProgram = state.programBoundaryStack.pop()!;
		state.result.programs.push({
			name: topProgram.name,
			startLine: topProgram.startLine,
			endLine: rawLines.length,
			nestingDepth: state.programBoundaryStack.length,
			procedureUsing: topProgram.procedureUsing,
			isCommon: topProgram.isCommon,
		});
	}
	// Sort by startLine so outer programs come first
	if (state.result.programs.length > 1) {
		state.result.programs.sort((a, b) => a.startLine - b.startLine);
	}

	return state.result;

	// =========================================================================
	// Inner function: process one logical line (after continuation merging)
	// =========================================================================
	function processLogicalLine(line: string, lineNum: number): void {
		// --- EXEC block accumulation (spans any division) ---
		if (state.execAccum !== null) {
			state.execAccum.lines += ` ${line}`;
			if (RE_END_EXEC.test(line)) {
				if (state.execAccum.type === "sql") {
					state.result.execSqlBlocks.push(
						parseExecSqlBlock(state.execAccum.lines, state.execAccum.startLine),
					);
				} else if (state.execAccum.type === "cics") {
					state.result.execCicsBlocks.push(
						parseExecCicsBlock(state.execAccum.lines, state.execAccum.startLine),
					);
				} else if (state.execAccum.type === "dli") {
					state.result.execDliBlocks.push(
						parseExecDliBlock(state.execAccum.lines, state.execAccum.startLine),
					);
				}
				state.execAccum = null;
			}
			return; // While accumulating, skip normal processing
		}

		// Check for EXEC SQL / EXEC CICS start
		// Flush any pending CALL accumulator before entering EXEC block
		if (RE_EXEC_SQL_START.test(line)) {
			flushCallAccum();
			state.execAccum = { type: "sql", lines: line, startLine: lineNum };
			// If END-EXEC is on the same line, finalize immediately
			if (RE_END_EXEC.test(line)) {
				state.result.execSqlBlocks.push(
					parseExecSqlBlock(state.execAccum.lines, state.execAccum.startLine),
				);
				state.execAccum = null;
			}
			return;
		}
		if (RE_EXEC_CICS_START.test(line)) {
			flushCallAccum();
			state.execAccum = { type: "cics", lines: line, startLine: lineNum };
			if (RE_END_EXEC.test(line)) {
				state.result.execCicsBlocks.push(
					parseExecCicsBlock(state.execAccum.lines, state.execAccum.startLine),
				);
				state.execAccum = null;
			}
			return;
		}
		if (RE_EXEC_DLI_START.test(line)) {
			flushCallAccum();
			state.execAccum = { type: "dli", lines: line, startLine: lineNum };
			if (RE_END_EXEC.test(line)) {
				state.result.execDliBlocks.push(
					parseExecDliBlock(state.execAccum.lines, state.execAccum.startLine),
				);
				state.execAccum = null;
			}
			return;
		}

		// --- END PROGRAM boundary detection ---
		const endProgramMatch = line.match(RE_END_PROGRAM);
		if (endProgramMatch) {
			// Flush any pending accumulators at program boundary
			flushCallAccum();
			flushSort();
			flushInspect();
			const topProgram = state.programBoundaryStack.pop();
			if (topProgram) {
				state.result.programs.push({
					name: topProgram.name,
					startLine: topProgram.startLine,
					endLine: lineNum,
					nestingDepth: state.programBoundaryStack.length,
					procedureUsing: topProgram.procedureUsing,
					isCommon: topProgram.isCommon,
				});
			}
			return;
		}

		// DECLARATIVES boundary detection
		if (RE_DECLARATIVES_START.test(line)) {
			state.inDeclaratives = true;
			return;
		}
		if (RE_DECLARATIVES_END.test(line)) {
			state.inDeclaratives = false;
			return;
		}

		// Detect PROGRAM-ID regardless of current division state (handles sibling
		// programs after END PROGRAM where IDENTIFICATION DIVISION header is omitted)
		if (state.currentDivision !== "identification") {
			const pgmIdMatch = line.match(RE_PROGRAM_ID);
			if (pgmIdMatch) {
				flushCallAccum();
				flushSort();
				flushInspect();
				extractIdentification(line, lineNum);
				return;
			}
		}

		// --- Division transitions ---
		const divMatch = line.match(RE_DIVISION);
		if (divMatch) {
			// Flush any pending accumulators on division boundary
			flushSelect();
			flushCallAccum();
			flushSort();
			flushInspect();

			const divName = divMatch[1].toUpperCase();
			switch (divName) {
				case "IDENTIFICATION":
					state.currentDivision = "identification";
					break;
				case "ENVIRONMENT":
					state.currentDivision = "environment";
					state.currentEnvSection = null;
					break;
				case "DATA":
					state.currentDivision = "data";
					state.currentDataSection = "unknown";
					break;
				case "PROCEDURE": {
					state.currentDivision = "procedure";
					state.currentParagraph = null;
					const procUsingMatch = line.match(RE_PROC_USING);
					if (procUsingMatch) {
						const params = procUsingMatch[1]
							.split(/\bRETURNING\b/i)[0]
							.trim()
							.split(/\s+/)
							.filter((s) => s.length > 0 && !USING_KEYWORDS.has(s.toUpperCase()));
						state.result.procedureUsing = params;
						// Store per-program on the boundary stack
						const topProg =
							state.programBoundaryStack[state.programBoundaryStack.length - 1];
						if (topProg) topProg.procedureUsing = params;
						state.pendingProcUsing = false;
					} else {
						// USING may be on the next line — flag for extractProcedure to pick up
						// Only set if the line is NOT period-terminated (period = no USING clause)
						state.pendingProcUsing = !/\.\s*$/.test(line);
					}
					break;
				}
			}
			return;
		}

		// --- Section transitions ---
		const secMatch = line.match(RE_SECTION);
		if (secMatch) {
			flushSelect();

			const secName = secMatch[1].toUpperCase();
			switch (secName) {
				case "WORKING-STORAGE":
					state.currentDivision = "data";
					state.currentDataSection = "working-storage";
					break;
				case "LINKAGE":
					state.currentDivision = "data";
					state.currentDataSection = "linkage";
					break;
				case "FILE":
					state.currentDivision = "data";
					state.currentDataSection = "file";
					break;
				case "LOCAL-STORAGE":
					state.currentDivision = "data";
					state.currentDataSection = "local-storage";
					break;
				case "SCREEN":
					state.currentDivision = "data";
					state.currentDataSection = "screen";
					break;
				case "INPUT-OUTPUT":
					state.currentDivision = "environment";
					state.currentEnvSection = "input-output";
					break;
				case "CONFIGURATION":
					state.currentDivision = "environment";
					state.currentEnvSection = "configuration";
					break;
			}
			return;
		}

		// --- COPY (all divisions) ---
		const copyQMatch = line.match(RE_COPY_QUOTED);
		if (copyQMatch) {
			state.result.copies.push({
				target: copyQMatch[1] ?? copyQMatch[2],
				line: lineNum,
			});
		} else {
			const copyUMatch = line.match(RE_COPY_UNQUOTED);
			if (copyUMatch) {
				state.result.copies.push({ target: copyUMatch[1], line: lineNum });
			}
		}

		// --- CALL (all divisions, typically procedure) ---
		// Multi-line CALL accumulator: accumulate CALL statement until period or END-CALL.
		// Continuation lines (not the start line) are consumed entirely — return after flush
		// to prevent false paragraph detection on lines like "WS-ADDR." or "WS-CUST-CODE."
		if (state.callAccum !== null) {
			// Check if this continuation line starts a new COBOL statement (not a USING parameter).
			// Use (?:\s|$) instead of \b to prevent matching hyphenated identifiers like MOVE-COUNT.
			// Only use RE_PROC_PARAGRAPH as flush trigger when in Area A (≤7 leading spaces, fixed-format).
			// In free-format, never use RE_PROC_PARAGRAPH (can't distinguish parameters from paragraphs).
			const trimmedLine = line.trimStart();
			const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
			const isAreaAParagraph =
				RE_PROC_PARAGRAPH.test(line) &&
				(!state.isFreeFormat ? leadingSpaces <= 7 : false);
			if (
				RE_STATEMENT_VERB_START.test(trimmedLine) ||
				RE_PROC_SECTION.test(line) ||
				isAreaAParagraph
			) {
				flushCallAccum(); // Flush CALL without this line's content
				// Fall through to process this line normally
			} else {
				state.callAccum += ` ${line}`;
				if (
					/\.\s*$/.test(state.callAccum) ||
					/\bEND-CALL\b/i.test(state.callAccum)
				) {
					flushCallAccum();
				}
				return; // continuation line consumed by CALL accumulator
			}
		} else if (
			state.currentDivision === "procedure" &&
			/(?<![A-Z0-9-])\bCALL\s+(?:"[^"]+"|'[^']+'|[A-Z][A-Z0-9-]+)/i.test(line)
		) {
			// Check if this is a complete single-line CALL (ends with period or END-CALL)
			if (/\.\s*$/.test(line) || /\bEND-CALL\b/i.test(line)) {
				// Single-line CALL — extract immediately via flushCallAccum
				state.callAccum = line;
				state.callAccumLine = lineNum;
				flushCallAccum();
			} else {
				// Multi-line CALL — start accumulating
				state.callAccum = line;
				state.callAccumLine = lineNum;
				return; // prevent CALL start line from feeding state.sortAccum/state.inspectAccum
			}
		}

		// --- Division-specific extraction ---
		switch (state.currentDivision) {
			case "identification":
				extractIdentification(line, lineNum);
				break;
			case "environment":
				extractEnvironment(line, lineNum);
				break;
			case "data":
				extractData(line, lineNum);
				break;
			case "procedure":
				extractProcedure(line, lineNum);
				break;
		}
	}

	// =========================================================================
	// IDENTIFICATION DIVISION extraction
	// =========================================================================
}
