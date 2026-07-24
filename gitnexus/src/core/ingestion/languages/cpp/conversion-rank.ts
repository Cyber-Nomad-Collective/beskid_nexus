/**
 * C++ conversion-rank scoring for overload resolution (#1578).
 *
 * Operates on **normalized** type strings (output of
 * `normalizeCppParamType` in `arity-metadata.ts`). After normalization:
 *   - int/long/short/unsigned → 'int'
 *   - float/double → 'double'
 *   - char → 'char', bool → 'bool'
 *
 * Because the normalizer collapses promotion pairs (int↔long,
 * float↔double) to the same string, those promotions are invisible at
 * this layer — they appear as exact matches (rank 0).
 *
 * Post-normalization ranking:
 *   - rank 0 — exact (same normalized type)
 *   - rank 1 — integral promotion (char→int, bool→int)
 *   - rank 2 — standard arithmetic conversion (int↔double, char→double,
 *              bool→double)
 *   - Infinity — mismatch (string↔int, user types, pointers, etc.)
 *
 * This function is intentionally C++-specific (issue #1578 pitfall:
 * keep conversion-rank tables out of shared overload-narrowing). Other
 * languages may define their own `ConversionRankFn` in the future.
 */

/** Set of normalized arithmetic types that support implicit conversion. */
const ARITHMETIC = new Set(["int", "double", "char", "bool"]);

/** Integral promotion targets: char→int and bool→int are rank 1. */
const INTEGRAL_PROMOTION = new Map([
	["char", "int"],
	["bool", "int"],
]);

/**
 * Return the conversion rank from `argType` to `paramType`.
 *
 * @returns 0 for exact match, 1 for integral promotion (char/bool→int),
 *          2 for standard arithmetic conversion, Infinity for mismatch.
 */
export function cppConversionRank(argType: string, paramType: string): number {
	if (argType === paramType) return 0;
	// Integral promotions: char→int, bool→int (ISO C++ [conv.prom])
	if (INTEGRAL_PROMOTION.get(argType) === paramType) return 1;
	if (ARITHMETIC.has(argType) && ARITHMETIC.has(paramType)) return 2;
	return Infinity;
}
