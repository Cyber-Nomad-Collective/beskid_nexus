import type { CobolRegexResults } from "../cobol/cobol-preprocessor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the enclosing program name for a given line number (innermost wins). */
export function findOwningProgramName(
	lineNum: number,
	programs: Array<{
		name: string;
		startLine: number;
		endLine: number;
		nestingDepth: number;
	}>,
): string | undefined {
	let best: (typeof programs)[0] | undefined;
	for (const p of programs) {
		if (p.startLine <= lineNum && p.endLine >= lineNum) {
			if (!best || p.nestingDepth > best.nestingDepth) best = p;
		}
	}
	return best?.name;
}

/** Find the section that contains a given line number. */
export function findContainingSection(
	line: number,
	sections: Array<{ name: string; line: number }>,
	sectionNodeIds: Map<string, string>,
	programs: Array<{
		name: string;
		startLine: number;
		endLine: number;
		nestingDepth: number;
	}>,
): string | undefined {
	const pgm = findOwningProgramName(line, programs);
	// Sections are in order; find the last section whose start line <= the target line
	let best: string | undefined;
	for (const sec of sections) {
		if (sec.line <= line) {
			const resolved = sectionNodeIds.get(
				`${pgm ?? ""}:${sec.name.toUpperCase()}`,
			);
			if (resolved) best = resolved; // only update if lookup succeeds
		} else {
			break;
		}
	}
	return best;
}

export interface CobolGraphLookups {
	scopedParaLookup(name: string, lineNum: number): string | undefined;
	scopedCallerLookup(name: string | null, lineNum: number): string;
	owningModuleId(lineNum: number): string;
}

export function createGraphLookups(
	extracted: CobolRegexResults,
	paraNodeIds: Map<string, string>,
	sectionNodeIds: Map<string, string>,
	programModuleIds: Map<string, string>,
	parentId: string,
): CobolGraphLookups {
	// Helper: look up paragraph/section by name scoped to the owning program
	const scopedParaLookup = (
		name: string,
		lineNum: number,
	): string | undefined => {
		const pgm = findOwningProgramName(lineNum, extracted.programs);
		return (
			paraNodeIds.get(`${pgm ?? ""}:${name.toUpperCase()}`) ??
			sectionNodeIds.get(`${pgm ?? ""}:${name.toUpperCase()}`)
		);
	};
	const scopedCallerLookup = (name: string | null, lineNum: number): string => {
		if (!name) return owningModuleId(lineNum);
		const pgm = findOwningProgramName(lineNum, extracted.programs);
		return (
			paraNodeIds.get(`${pgm ?? ""}:${name.toUpperCase()}`) ??
			programModuleIds.get(pgm ?? "") ??
			parentId
		);
	};
	/** Resolve the owning program's module ID for a given line (for nested program edge attribution). */
	const owningModuleId = (lineNum: number): string => {
		const pgm = findOwningProgramName(lineNum, extracted.programs);
		return programModuleIds.get(pgm ?? "") ?? parentId;
	};

	return { scopedParaLookup, scopedCallerLookup, owningModuleId };
}

