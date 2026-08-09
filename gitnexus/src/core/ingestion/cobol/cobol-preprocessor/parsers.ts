import type { CobolRegexResults } from "./contracts.js";

// ---------------------------------------------------------------------------
// Private helper: parse data item trailing clauses (PIC, USAGE, etc.)
// ---------------------------------------------------------------------------

export function parseDataItemClauses(rest: string): {
	pic?: string;
	usage?: string;
	redefines?: string;
	occurs?: number;
	dependingOn?: string;
	value?: string;
	isExternal?: boolean;
	isGlobal?: boolean;
} {
	const result: {
		pic?: string;
		usage?: string;
		redefines?: string;
		occurs?: number;
		dependingOn?: string;
		value?: string;
		isExternal?: boolean;
		isGlobal?: boolean;
	} = {};

	// Strip trailing period for easier parsing
	const text = rest.replace(/\.\s*$/, "");

	// PIC / PICTURE [IS] <picture-string>
	const picMatch = text.match(/\bPIC(?:TURE)?\s+(?:IS\s+)?(\S+)/i);
	if (picMatch) {
		result.pic = picMatch[1];
	}

	// USAGE [IS] <usage-type> — including non-standard COMP-6, COMP-X etc.
	const usageMatch = text.match(
		/\bUSAGE\s+(?:IS\s+)?(COMP(?:UTATIONAL)?(?:-[0-9X])?|BINARY|PACKED-DECIMAL|DISPLAY|INDEX|POINTER|NATIONAL)\b/i,
	);
	if (usageMatch) {
		result.usage = usageMatch[1].toUpperCase();
	} else {
		// Standalone COMP variants without USAGE keyword
		const compMatch = text.match(
			/\b(COMP(?:UTATIONAL)?(?:-[0-9X])?|BINARY|PACKED-DECIMAL)\b/i,
		);
		if (compMatch) {
			result.usage = compMatch[1].toUpperCase();
		}
	}

	// REDEFINES <name>
	const redefMatch = text.match(/\bREDEFINES\s+([A-Z][A-Z0-9-]+)/i);
	if (redefMatch) {
		result.redefines = redefMatch[1];
	}

	// OCCURS <n> [TO <m>] [TIMES] [DEPENDING ON <field>]
	const occursMatch = text.match(
		/\bOCCURS\s+(\d+)(?:\s+TO\s+(\d+))?\s*(?:TIMES\s*)?(?:DEPENDING\s+ON\s+([A-Z][A-Z0-9-]+(?:\s*\([^)]*\))?))?/i,
	);
	if (occursMatch) {
		result.occurs = parseInt(occursMatch[1], 10);
		if (occursMatch[3]) {
			// Strip any subscript from DEPENDING ON field
			result.dependingOn = occursMatch[3].replace(/\s*\([^)]*\)/, "").trim();
		}
	}

	// IS EXTERNAL / IS GLOBAL
	result.isExternal = /\bIS\s+EXTERNAL\b/i.test(text) || undefined;
	result.isGlobal = /\bIS\s+GLOBAL\b/i.test(text) || undefined;

	// VALUE [IS] literal/constant
	if (!result.value) {
		const valueIdx = text.search(/\bVALUE\b/i);
		if (valueIdx >= 0) {
			const afterValue = text
				.substring(valueIdx + 5)
				.replace(/^\s+IS\s+/i, "")
				.trimStart();
			// Try quoted: "..." or '...' (with optional type prefix X, N, G, B)
			const quotedMatch = afterValue.match(/^([XNGB])?(?:"([^"]*)"|'([^']*)')/i);
			if (quotedMatch) {
				const prefix = quotedMatch[1] ? quotedMatch[1].toUpperCase() : "";
				result.value = prefix
					? `${prefix}'${quotedMatch[2] ?? quotedMatch[3]}'`
					: (quotedMatch[2] ?? quotedMatch[3]);
			} else {
				// Try ALL "..." or ALL '...'
				const allMatch = afterValue.match(/^ALL\s+(?:"([^"]*)"|'([^']*)')/i);
				if (allMatch) {
					result.value = `ALL '${allMatch[1] ?? allMatch[2]}'`;
				} else {
					// Try numeric (including negative, decimal)
					const numMatch = afterValue.match(/^(-?\d+\.?\d*)/);
					if (numMatch) {
						result.value = numMatch[1];
					} else {
						// Try figurative constant or identifier
						const identMatch = afterValue.match(/^([A-Z][A-Z0-9-]*)/i);
						if (identMatch) result.value = identMatch[1].toUpperCase();
					}
				}
			}
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Private helper: parse 88-level condition values
// ---------------------------------------------------------------------------

export function parseConditionValues(valuesStr: string): string[] {
	// Strip trailing period
	const text = valuesStr.replace(/\.\s*$/, "").trim();
	const values: string[] = [];

	// Match quoted strings: "O" "Y" "I"
	const quotedRe = /(?:"([^"]*)"|'([^']*)')/g;
	let qm: RegExpExecArray | null;
	let hasQuoted = false;
	while ((qm = quotedRe.exec(text)) !== null) {
		values.push(qm[1] ?? qm[2]);
		hasQuoted = true;
	}
	if (hasQuoted) return values;

	// No quotes — split on whitespace, filtering out THRU/THROUGH keywords
	// Handle: 11 12 16 17 21   or   1 THRU 5
	const tokens = text.split(/\s+/);
	for (const token of tokens) {
		const upper = token.toUpperCase();
		if (upper === "THRU" || upper === "THROUGH") {
			// Keep THRU ranges as combined value: prev THRU next is already captured
			// by having both sides in the array
			continue;
		}
		if (token.length > 0) {
			values.push(token);
		}
	}

	return values;
}

// ---------------------------------------------------------------------------
// Private helper: parse accumulated multi-line SELECT statement
// ---------------------------------------------------------------------------

export interface FileDeclaration {
	selectName: string;
	assignTo: string;
	organization?: string;
	access?: string;
	recordKey?: string;
	alternateKeys?: string[];
	fileStatus?: string;
	isOptional?: boolean;
	line: number;
}

export function parseSelectStatement(
	stmt: string,
	startLine: number,
): FileDeclaration | null {
	// Normalize whitespace
	const text = stmt.replace(/\s+/g, " ").trim();

	const nameMatch = text.match(/^SELECT\s+(?:OPTIONAL\s+)?([A-Z][A-Z0-9-]+)/i);
	if (!nameMatch) return null;

	const result: FileDeclaration = {
		selectName: nameMatch[1],
		assignTo: "",
		line: startLine,
	};

	const assignMatch = text.match(
		/\bASSIGN\s+(?:TO\s+)?("([^"]+)"|([A-Z][A-Z0-9-]*))/i,
	);
	if (assignMatch) {
		result.assignTo = assignMatch[2] || assignMatch[3] || "";
	}

	const orgMatch = text.match(
		/\bORGANIZATION\s+(?:IS\s+)?(SEQUENTIAL|INDEXED|RELATIVE|LINE\s+SEQUENTIAL)/i,
	);
	if (orgMatch) {
		result.organization = orgMatch[1].toUpperCase();
	}

	const accessMatch = text.match(
		/\bACCESS\s+(?:MODE\s+)?(?:IS\s+)?(SEQUENTIAL|RANDOM|DYNAMIC)/i,
	);
	if (accessMatch) {
		result.access = accessMatch[1].toUpperCase();
	}

	const keyMatch = text.match(/\bRECORD\s+KEY\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)/i);
	if (keyMatch) {
		result.recordKey = keyMatch[1];
	}

	// ALTERNATE RECORD KEY
	const altKeyMatches = text.matchAll(
		/\bALTERNATE\s+RECORD\s+KEY\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)/gi,
	);
	const alternateKeys: string[] = [];
	for (const m of altKeyMatches) alternateKeys.push(m[1]);
	if (alternateKeys.length > 0) result.alternateKeys = alternateKeys;

	// FILE STATUS IS / STATUS IS
	const statusMatch = text.match(
		/\b(?:FILE\s+)?STATUS\s+(?:IS\s+)?([A-Z][A-Z0-9-]+)/i,
	);
	if (statusMatch) {
		result.fileStatus = statusMatch[1];
	}

	// SELECT OPTIONAL flag
	result.isOptional = /^SELECT\s+OPTIONAL\b/i.test(text) || undefined;

	return result;
}

// ---------------------------------------------------------------------------
// Private helper: parse EXEC SQL block
// ---------------------------------------------------------------------------

export type SqlOperation =
	| "SELECT"
	| "INSERT"
	| "UPDATE"
	| "DELETE"
	| "DECLARE"
	| "OPEN"
	| "CLOSE"
	| "FETCH"
	| "OTHER";

export function parseExecSqlBlock(
	block: string,
	line: number,
): CobolRegexResults["execSqlBlocks"][number] {
	// Strip EXEC SQL ... END-EXEC wrapper
	const body = block
		.replace(/\bEXEC\s+SQL\b/i, "")
		.replace(/\bEND-EXEC\b/i, "")
		.replace(/\s+/g, " ")
		.trim();

	// Determine operation from first SQL keyword
	const firstWord = body.split(/\s+/)[0]?.toUpperCase() || "";
	const OP_MAP: Record<string, SqlOperation> = {
		SELECT: "SELECT",
		INSERT: "INSERT",
		UPDATE: "UPDATE",
		DELETE: "DELETE",
		DECLARE: "DECLARE",
		OPEN: "OPEN",
		CLOSE: "CLOSE",
		FETCH: "FETCH",
		INCLUDE: "OTHER", // we handle INCLUDE specially below
	};
	const operation: SqlOperation = OP_MAP[firstWord] || "OTHER";

	// EXEC SQL INCLUDE — extract member name for IMPORTS edge
	let includeMember: string | undefined;
	if (firstWord === "INCLUDE") {
		const includeMatch = body.match(
			/^INCLUDE\s+(?:'([^']+)'|"([^"]+)"|([A-Z][A-Z0-9_-]+))/i,
		);
		if (includeMatch) {
			includeMember = includeMatch[1] ?? includeMatch[2] ?? includeMatch[3];
		}
	}

	// Extract table names from FROM, INTO (INSERT), UPDATE, DELETE FROM, JOIN
	const tables: string[] = [];
	const tablePatterns = [
		/\bFROM\s+([A-Z][A-Z0-9_]+)/gi,
		/\bINSERT\s+INTO\s+([A-Z][A-Z0-9_]+)/gi,
		/\bUPDATE\s+([A-Z][A-Z0-9_]+)/gi,
		/\bJOIN\s+([A-Z][A-Z0-9_]+)/gi,
	];
	for (const re of tablePatterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(body)) !== null) {
			const name = m[1].toUpperCase();
			// Skip host variables and SQL keywords
			if (!name.startsWith(":") && !tables.includes(name)) {
				tables.push(name);
			}
		}
	}

	// Extract cursor names from DECLARE ... CURSOR
	const cursors: string[] = [];
	const cursorRe = /\bDECLARE\s+([A-Z][A-Z0-9_-]+)\s+CURSOR\b/gi;
	let cm: RegExpExecArray | null;
	while ((cm = cursorRe.exec(body)) !== null) {
		cursors.push(cm[1]);
	}

	// Extract host variables: :VARIABLE-NAME (strip the colon)
	const hostVariables: string[] = [];
	const hostRe = /:([A-Z][A-Z0-9-]+)/gi;
	let hm: RegExpExecArray | null;
	while ((hm = hostRe.exec(body)) !== null) {
		const name = hm[1];
		if (!hostVariables.includes(name)) {
			hostVariables.push(name);
		}
	}

	return { line, tables, cursors, hostVariables, operation, includeMember };
}

// ---------------------------------------------------------------------------
// Private helper: parse EXEC CICS block
// ---------------------------------------------------------------------------

export function parseExecCicsBlock(
	block: string,
	line: number,
): CobolRegexResults["execCicsBlocks"][number] {
	// Strip EXEC CICS ... END-EXEC wrapper
	const body = block
		.replace(/\bEXEC\s+CICS\b/i, "")
		.replace(/\bEND-EXEC\b/i, "")
		.replace(/\s+/g, " ")
		.trim();

	// Command: first keyword(s) — handle two-word commands like SEND MAP, RECEIVE MAP
	const twoWordCommands = [
		"SEND MAP",
		"RECEIVE MAP",
		"SEND TEXT",
		"SEND CONTROL",
		"READ NEXT",
		"READ PREV",
		"WRITEQ TS",
		"WRITEQ TD",
		"READQ TS",
		"READQ TD",
		"DELETEQ TS",
		"DELETEQ TD",
		"HANDLE ABEND",
		"HANDLE AID",
		"HANDLE CONDITION",
		"START TRANSID",
	];
	let command = "";
	const upperBody = body.toUpperCase();
	for (const twoWord of twoWordCommands) {
		if (upperBody.startsWith(twoWord)) {
			command = twoWord;
			break;
		}
	}
	if (!command) {
		command = body.split(/\s+/)[0]?.toUpperCase() || "";
	}

	const result: CobolRegexResults["execCicsBlocks"][number] = { line, command };

	// MAP name: MAP('name') or MAP("name") or MAP(IDENTIFIER)
	const mapMatch = body.match(
		/\bMAP\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i,
	);
	if (mapMatch) result.mapName = mapMatch[1] ?? mapMatch[2];

	// PROGRAM name: PROGRAM('name') or PROGRAM("name") or PROGRAM(VARIABLE)
	const progMatch = body.match(
		/\bPROGRAM\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i,
	);
	if (progMatch) {
		result.programName = progMatch[1] ?? progMatch[2];
		result.programIsLiteral = !!progMatch[1];
	}

	// TRANSID: TRANSID('name') or TRANSID("name") or TRANSID(VARIABLE)
	const transMatch = body.match(
		/\bTRANSID\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i,
	);
	if (transMatch) result.transId = transMatch[1] ?? transMatch[2];

	// FILE/DATASET: FILE('name') or DATASET('name') or FILE(VARIABLE)
	// Used in CICS READ, WRITE, REWRITE, DELETE, STARTBR, READNEXT, READPREV, ENDBR
	const fileMatch = body.match(
		/\b(?:FILE|DATASET)\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i,
	);
	if (fileMatch) {
		result.fileName = fileMatch[1] ?? fileMatch[2];
		result.fileIsLiteral = !!fileMatch[1];
	}

	// QUEUE: QUEUE('name') — used in WRITEQ/READQ TS/TD
	const queueMatch = body.match(
		/\bQUEUE\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z][A-Z0-9-]+))\s*\)/i,
	);
	if (queueMatch) result.queueName = queueMatch[1] ?? queueMatch[2];

	// HANDLE ABEND LABEL(paragraph-name) — error handler target
	const labelMatch = body.match(/\bLABEL\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
	if (labelMatch) result.labelName = labelMatch[1];

	// INTO(data-area) — data target (READ INTO, RECEIVE INTO, RETRIEVE INTO, READQ INTO)
	const intoMatch = body.match(/\bINTO\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
	if (intoMatch) result.intoField = intoMatch[1];

	// FROM(data-area) — data source (WRITE FROM, SEND FROM, WRITEQ FROM, START FROM)
	const fromMatch = body.match(/\bFROM\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
	if (fromMatch) result.fromField = fromMatch[1];

	return result;
}

// ---------------------------------------------------------------------------
// Private helper: parse EXEC DLI block (IMS/DB)
// ---------------------------------------------------------------------------

export function parseExecDliBlock(
	block: string,
	line: number,
): CobolRegexResults["execDliBlocks"][number] {
	const body = block
		.replace(/\bEXEC\s+DLI\b/i, "")
		.replace(/\bEND-EXEC\b/i, "")
		.replace(/\s+/g, " ")
		.trim();
	const verb = body.split(/\s+/)[0]?.toUpperCase() || "";
	const result: CobolRegexResults["execDliBlocks"][number] = { line, verb };

	const pcbMatch = body.match(/\bUSING\s+PCB\s*\(\s*(\d+)\s*\)/i);
	if (pcbMatch) result.pcbNumber = parseInt(pcbMatch[1], 10);

	const segMatch = body.match(/\bSEGMENT\s*\(\s*([A-Z][A-Z0-9-]*)\s*\)/i);
	if (segMatch) result.segmentName = segMatch[1];

	const intoMatch = body.match(/\bINTO\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
	if (intoMatch) result.intoField = intoMatch[1];

	const fromMatch = body.match(/\bFROM\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
	if (fromMatch) result.fromField = fromMatch[1];

	const psbMatch = body.match(/\bPSB\s*\(\s*([A-Z][A-Z0-9-]+)\s*\)/i);
	if (psbMatch) result.psbName = psbMatch[1];

	return result;
}
