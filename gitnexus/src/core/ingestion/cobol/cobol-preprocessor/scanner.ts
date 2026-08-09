// ---------------------------------------------------------------------------
// Preserved exactly: EXCLUDED_PARA_NAMES
// ---------------------------------------------------------------------------

// COBOL calling-convention keywords to filter from USING parameter lists
export const USING_KEYWORDS = new Set([
	"BY",
	"VALUE",
	"REFERENCE",
	"CONTENT",
	"ADDRESS",
	"OF",
	"RETURNING",
]);

// CALL ... USING keyword filter (extends USING_KEYWORDS for CALL-specific forms)
export const CALL_USING_FILTER = new Set([
	"BY",
	"REFERENCE",
	"CONTENT",
	"VALUE",
	"ADDRESS",
	"OF",
	"LENGTH",
	"OMITTED",
]);

export const EXCLUDED_PARA_NAMES = new Set([
	"DECLARATIVES",
	"END",
	"PROCEDURE",
	"IDENTIFICATION",
	"ENVIRONMENT",
	"DATA",
	"WORKING-STORAGE",
	"LINKAGE",
	"FILE",
	"LOCAL-STORAGE",
	"COMMUNICATION",
	"REPORT",
	"SCREEN",
	"INPUT-OUTPUT",
	"CONFIGURATION",
	// COBOL verbs that appear alone on a line with period (false-positive in free-format)
	"GOBACK",
	"STOP",
	"EXIT",
	"CONTINUE",
	"DISPLAY",
	"ACCEPT",
	"WRITE",
	"READ",
	"REWRITE",
	"DELETE",
	"OPEN",
	"CLOSE",
	"RETURN",
	"RELEASE",
	"SORT",
	"MERGE",
]);

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

export type Division =
	| "identification"
	| "environment"
	| "data"
	| "procedure"
	| null;

export type DataSection =
	| "working-storage"
	| "linkage"
	| "file"
	| "local-storage"
	| "screen"
	| "unknown";

export type EnvironmentSection = "input-output" | "configuration" | null;

// ---------------------------------------------------------------------------
// Regex constants (compiled once, reused across calls)
// ---------------------------------------------------------------------------

export const RE_DIVISION =
	/\b(IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION\b/i;
export const RE_SECTION =
	/\b(WORKING-STORAGE|LINKAGE|FILE|LOCAL-STORAGE|SCREEN|INPUT-OUTPUT|CONFIGURATION)\s+SECTION\b/i;

// IDENTIFICATION DIVISION
export const RE_PROGRAM_ID =
	/\bPROGRAM-ID\.\s*([A-Z][A-Z0-9-]*)(?:\s+IS\s+COMMON)?/i;
export const RE_END_PROGRAM = /\bEND\s+PROGRAM\s+([A-Z][A-Z0-9-]*)\s*\./i;
export const RE_AUTHOR = /^\s+AUTHOR\.\s*(.+)/i;
export const RE_DATE_WRITTEN = /^\s+DATE-WRITTEN\.\s*(.+)/i;
export const RE_DATE_COMPILED = /^\s+DATE-COMPILED\.\s*(.+)/i;
export const RE_INSTALLATION = /^\s+INSTALLATION\.\s*(.+)/i;

// ENVIRONMENT DIVISION — SELECT
export const RE_SELECT_START = /\bSELECT\s+(?:OPTIONAL\s+)?([A-Z][A-Z0-9-]+)/i;

// DATA DIVISION
// ^\s* (not ^\s+) to support both fixed-format (indented) and free-format (trimmed)
export const RE_FD = /^\s*(?:FD|SD|RD)\s+([A-Z][A-Z0-9-]+)/i;
export const RE_DATA_ITEM = /^\s*(\d{1,2})\s+([A-Z][A-Z0-9-]+)\s*(.*)/i;
export const RE_ANONYMOUS_REDEFINES =
	/^\s*(\d{1,2})\s+REDEFINES\s+([A-Z][A-Z0-9-]+)/i;
export const RE_88_LEVEL =
	/^\s*88\s+([A-Z][A-Z0-9-]+)\s+VALUES?\s+(?:ARE\s+)?(.+)/i;

// PROCEDURE DIVISION
// These patterns support both fixed-format (7 leading spaces) and free-format (any indentation)
export const RE_PROC_SECTION =
	/^\s*([A-Z][A-Z0-9-]+)\s+SECTION(?:\s+\d+)?\.\s*$/i;
export const RE_PROC_PARAGRAPH = /^\s*([A-Z][A-Z0-9-]+)\.\s*$/i;
export const RE_PERFORM =
	/\bPERFORM\s+([A-Z][A-Z0-9-]+)(?:\s+(?:THRU|THROUGH)\s+([A-Z][A-Z0-9-]+))?/gi;

// ALL DIVISIONS
// Both double-quoted ("PROG") and single-quoted ('PROG') targets are valid COBOL.
// Use separate alternation groups so quotes must match (prevents "PROG' false-matches).
export const RE_CALL = /\bCALL\s+(?:"([^"]+)"|'([^']+)')/gi;
// Dynamic CALL via data item (no quotes): CALL WS-PROGRAM-NAME
export const RE_CALL_DYNAMIC =
	/(?<![A-Z0-9-])\bCALL\s+([A-Z][A-Z0-9-]+)(?=\s|\.|$)/gi;
export const RE_COPY_UNQUOTED = /\bCOPY\s+([A-Z][A-Z0-9-]+)(?:\s|\.)/i;
export const RE_COPY_QUOTED = /\bCOPY\s+(?:"([^"]+)"|'([^']+)')(?:\s|\.)/i;

// EXEC blocks
export const RE_EXEC_SQL_START = /\bEXEC\s+SQL\b/i;
export const RE_EXEC_CICS_START = /\bEXEC\s+CICS\b/i;
export const RE_END_EXEC = /\bEND-EXEC\b/i;

// GO TO — control flow transfer (same graph semantics as PERFORM)
// GO TO — captures first target; GO TO p1 p2 p3 DEPENDING ON x handled below
export const RE_GOTO =
	/\bGO\s+TO\s+([A-Z][A-Z0-9-]+(?:\s+[A-Z][A-Z0-9-]+)*?)(?:\s+DEPENDING\s+ON\s+[A-Z][A-Z0-9-]+)?(?:\s*\.|$)/i;

// SORT/MERGE file references
export const RE_SORT = /\bSORT\s+([A-Z][A-Z0-9-]+)/i;
export const RE_MERGE = /\bMERGE\s+([A-Z][A-Z0-9-]+)/i;

// SEARCH — table access
export const RE_SEARCH = /\bSEARCH\s+(?:ALL\s+)?([A-Z][A-Z0-9-]+)/i;

// CANCEL — program lifecycle
export const RE_CANCEL = /\bCANCEL\s+(?:"([^"]+)"|'([^']+)')/gi;
export const RE_CANCEL_DYNAMIC =
	/(?<![A-Z0-9-])\bCANCEL\s+([A-Z][A-Z0-9-]+)(?=\s|\.|$)/gi;

// Level 66 RENAMES
export const RE_66_LEVEL =
	/^\s*66\s+([A-Z][A-Z0-9-]+)\s+RENAMES\s+([A-Z][A-Z0-9-]+)/i;

// DECLARATIVES boundary and USE AFTER EXCEPTION
export const RE_DECLARATIVES_START = /^\s*DECLARATIVES\s*\.\s*$/i;
export const RE_DECLARATIVES_END = /^\s*END\s+DECLARATIVES\s*\.\s*$/i;
export const RE_USE_AFTER =
	/\bUSE\s+(?:AFTER\s+)?(?:STANDARD\s+)?(?:EXCEPTION|ERROR)\s+ON\s+([A-Z][A-Z0-9-]+|INPUT|OUTPUT|I-O|EXTEND)\b/i;

// SET statement (condition, index)
//
// Catastrophic-backtracking note (CodeQL js/redos): the previous shape
// `((?:[A-Z][A-Z0-9-]+(?:\s+OF\s+[A-Z][A-Z0-9-]+)?\s+)+)TO\s+TRUE`
// nested `\s+` quantifiers across alternations and was exponential on
// inputs like "SET a OF a OF a ... TO TRUE". Replaced with a lazy
// dot-match bounded by the explicit `\s+TO\s+TRUE` suffix — `.+?` is
// O(n) with the trailing anchor, and the captured group is parsed
// downstream the same way as before.
// Exported so the U8 ReDoS regression test can pin the exact production
// pattern. Direct import is the only way to ensure the test's
// pathological-input timing assertion exercises the production regex
// instead of an inline copy that drifts.
export const RE_SET_TO_TRUE = /\bSET\s+(.+?)\s+TO\s+TRUE\b/i;
export const RE_SET_INDEX =
	/\bSET\s+(.+?)\s+(TO|UP\s+BY|DOWN\s+BY)\s+(\d+|[A-Z][A-Z0-9-]+)/i;

// INITIALIZE statement — data reset (captures targets before REPLACING/WITH clause)
export const RE_INITIALIZE =
	/\bINITIALIZE\s+([\s\S]*?)(?=\bREPLACING\b|\bWITH\b|\.\s*$|$)/i;
export const INITIALIZE_CLAUSE_KEYWORDS = new Set([
	"REPLACING",
	"WITH",
	"ALL",
	"ALPHABETIC",
	"ALPHANUMERIC",
	"NUMERIC",
	"NATIONAL",
	"DBCS",
	"EGCS",
	"FILLER",
]);

// EXEC DLI (IMS/DB)
export const RE_EXEC_DLI_START = /\bEXEC\s+DLI\b/i;

// PROCEDURE DIVISION USING
export const RE_PROC_USING =
	/\bPROCEDURE\s+DIVISION\s+USING\s+([\s\S]*?)(?:\.|$)/i;

// ENTRY point
export const RE_ENTRY =
	/\bENTRY\s+(?:"([^"]+)"|'([^']+)')(?:\s+USING\s+([\s\S]*?))?(?:\.|$)/i;

// MOVE statement — captures everything after TO for multi-target extraction
export const RE_MOVE =
	/\bMOVE\s+((?:CORRESPONDING|CORR)\s+)?([A-Z][A-Z0-9-]+)\s+TO\s+(.+)/i;
export const MOVE_SKIP = new Set([
	"SPACES",
	"ZEROS",
	"ZEROES",
	"LOW-VALUES",
	"LOW-VALUE",
	"HIGH-VALUES",
	"HIGH-VALUE",
	"QUOTES",
	"QUOTE",
	"ALL",
]);

/**
 * Parse the text after "MOVE ... TO" into an array of target variable names.
 * Handles: multiple targets, OF/IN qualifiers, subscripts, trailing periods.
 * MOVE CORRESPONDING is always single-target per COBOL standard.
 */
export function extractMoveTargets(afterTo: string): string[] {
	// Strip trailing period and everything after it
	const text = afterTo.replace(/\..*$/, "").trim();
	if (!text) return [];

	// Remove subscript/reference-modification parenthesized suffixes
	const noSubscripts = text.replace(/\([^)]*\)/g, "");
	const tokens = noSubscripts.split(/\s+/).filter((t) => t.length > 0);

	const targets: string[] = [];
	const QUAL_KEYWORDS = new Set(["OF", "IN"]);
	let skipNext = false;
	for (const token of tokens) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (QUAL_KEYWORDS.has(token.toUpperCase())) {
			skipNext = true;
			continue;
		}
		if (/^[A-Z][A-Z0-9-]+$/i.test(token) && !MOVE_SKIP.has(token.toUpperCase())) {
			targets.push(token);
		}
	}
	return targets;
}

// PERFORM: keywords that may follow PERFORM but are NOT paragraph/section names.
// Inline PERFORM loops (UNTIL, VARYING) and inline test clauses (WITH TEST,
// FOREVER) must not be stored as perform-target false positives.
export const PERFORM_KEYWORD_SKIP = new Set([
	"UNTIL",
	"VARYING",
	"WITH",
	"TEST",
	"FOREVER",
]);

// SORT/MERGE clause keywords that should not be captured as file names
export const SORT_CLAUSE_NOISE = new Set([
	"ON",
	"ASCENDING",
	"DESCENDING",
	"KEY",
	"WITH",
	"DUPLICATES",
	"IN",
	"ORDER",
	"COLLATING",
	"SEQUENCE",
	"IS",
	"THROUGH",
	"THRU",
	"INPUT",
	"OUTPUT",
	"PROCEDURE",
	"USING",
	"GIVING",
]);

// COBOL statement verbs used as boundary detectors across accumulators.
// Shared by: callAccum flush trigger, inspectAccum flush trigger, and USING lookahead.
// Note: CALL is intentionally excluded — it's handled by the callAccum state machine.
// Including CALL here would cause the flush trigger to consume the new CALL line
// without re-detecting it as a CALL start.
export const COBOL_STATEMENT_VERBS = [
	"GO\\s+TO",
	"PERFORM",
	"MOVE",
	"DISPLAY",
	"ACCEPT",
	"INSPECT",
	"SEARCH",
	"SORT",
	"MERGE",
	"IF",
	"EVALUATE",
	"SET",
	"INITIALIZE",
	"STOP",
	"EXIT",
	"GOBACK",
	"CONTINUE",
	"READ",
	"WRITE",
	"REWRITE",
	"DELETE",
	"OPEN",
	"CLOSE",
	"START",
	"CANCEL",
	"COMPUTE",
	"ADD",
	"SUBTRACT",
	"MULTIPLY",
	"DIVIDE",
	"STRING",
	"UNSTRING",
];

/** Regex matching start of any COBOL statement verb (for accumulator flush triggers). */
export const RE_STATEMENT_VERB_START = new RegExp(
	`^(?:${COBOL_STATEMENT_VERBS.join("|")})(?:\\s|$)`,
	"i",
);

/** Lookahead alternation for USING parameter extraction (stops before statement verbs).
 *  Includes CALL (excluded from COBOL_STATEMENT_VERBS to avoid callAccum conflicts). */
export const USING_VERB_LOOKAHEAD = [...COBOL_STATEMENT_VERBS, "CALL"]
	.filter((v) => v !== "GO\\s+TO") // GO TO handled separately with \bGO\s+TO\b
	.map((v) => `\\b${v}(?=\\s|$)`)
	.join("|");
export const RE_USING_PARAMS = new RegExp(
	`\\bUSING\\s+([\\s\\S]*?)(?=\\bRETURNING\\b|\\bON\\s+(?:EXCEPTION|OVERFLOW)\\b|\\bNOT\\s+ON\\b|\\bEND-CALL\\b|\\bGO\\s+TO\\b|${USING_VERB_LOOKAHEAD}|\\.\\s*$|$)`,
	"i",
);

// ---------------------------------------------------------------------------
// Private helper: strip Italian inline comments (| and everything after)
// ---------------------------------------------------------------------------

export function stripInlineComment(line: string): string {
	let inQuote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuote) {
			if (ch === inQuote) inQuote = null;
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
		} else if (ch === "|") {
			return line.substring(0, i);
		}
	}
	return line;
}
