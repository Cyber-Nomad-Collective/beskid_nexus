import type { SupportedLanguages } from "gitnexus-shared";
import type { AstFrameworkPatternConfig } from "../language-provider.js";
import { providers } from "../languages/index.js";
import type { FrameworkHint } from "./contracts.js";

// ============================================================================
// AST-BASED FRAMEWORK DETECTION
// ============================================================================

/** Pre-lowercased patterns for O(1) pattern matching at runtime — built from providers. */
const AST_PATTERNS_LOWERED: Record<string, AstFrameworkPatternConfig[]> =
	Object.fromEntries(
		Object.entries(providers).map(([lang, provider]) => [
			lang,
			(provider.astFrameworkPatterns ?? []).map((cfg) => ({
				...cfg,
				patterns: cfg.patterns.map((p) => p.toLowerCase()),
			})),
		]),
	);

/**
 * Detect framework entry points from AST definition text (decorators/annotations/attributes).
 * Returns null if no known pattern is found.
 * Note: callers should slice definitionText to ~300 chars since annotations appear at the start.
 */
export function detectFrameworkFromAST(
	language: SupportedLanguages,
	definitionText: string,
): FrameworkHint | null {
	if (!language || !definitionText) return null;

	const configs = AST_PATTERNS_LOWERED[language.toLowerCase()];
	if (!configs || configs.length === 0) return null;

	const normalized = definitionText.toLowerCase();

	for (const cfg of configs) {
		for (const pattern of cfg.patterns) {
			if (normalized.includes(pattern)) {
				return {
					framework: cfg.framework,
					entryPointMultiplier: cfg.entryPointMultiplier,
					reason: cfg.reason,
				};
			}
		}
	}

	return null;
}
