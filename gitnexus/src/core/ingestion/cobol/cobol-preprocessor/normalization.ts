// ---------------------------------------------------------------------------
// Preserved exactly: preprocessCobolSource
// ---------------------------------------------------------------------------

/**
 * Normalize COBOL source for regex-based extraction.
 *
 * The COBOL fixed-format sequence number area (columns 1-6) is semantically
 * irrelevant to parsing — compilers and tools always ignore it.  This
 * function replaces ANY non-space content in columns 1-6 with spaces
 * so that position-sensitive regexes (paragraph/section detection, data-item
 * anchors, etc.) work identically whether the file carries numeric sequence
 * numbers (000100), alphabetic patch markers (mzADD, estero, #patch), or
 * the COBOL default of all spaces.
 *
 * Preserves exact line count for position mapping.
 */
export function preprocessCobolSource(content: string): string {
	// Skip preprocessing for free-format COBOL — cols 1-6 are program text, not sequence area
	// Check first 10 lines (consistent with extractCobolSymbolsWithRegex detection threshold)
	const firstLines = content.split("\n", 10).join("\n");
	if (/>>SOURCE\s+(?:FORMAT\s+(?:IS\s+)?)?FREE/i.test(firstLines)) {
		return content;
	}

	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.length < 7) continue;
		const seq = line.substring(0, 6);
		// Replace any non-space content in the sequence area with spaces.
		// This covers numeric sequence numbers (000100), alphabetic patch markers
		// (mzADD, estero), '#'-prefixed markers, and all other col 1-6 content.
		if (/\S/.test(seq)) {
			lines[i] = `      ${line.substring(6)}`;
		}
	}
	return lines.join("\n");
}
