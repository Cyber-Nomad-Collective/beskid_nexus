import type { FrameworkHint } from "./contracts.js";
import {
	detectMobileFramework,
	detectSystemsFramework,
} from "./systems-mobile-matchers.js";
import { detectWebLanguageFramework } from "./web-language-matchers.js";

/**
 * Detect framework from file path patterns
 *
 * This provides entry point multipliers based on well-known framework conventions.
 * Returns null if no framework pattern is detected (falls back to 1.0 multiplier).
 */
export function detectFrameworkFromPath(
	filePath: string,
): FrameworkHint | null {
	// Normalize path separators and ensure leading slash for consistent matching
	const originalPath = filePath.replace(/\\/g, "/");
	let p = originalPath.toLowerCase();
	if (!p.startsWith("/")) {
		p = `/${p}`; // Add leading slash so patterns like '/app/' match 'app/...'
	}
	const originalPathWithLeadingSlash = originalPath.startsWith("/")
		? originalPath
		: `/${originalPath}`;
	const context = { p, originalPathWithLeadingSlash };
	return (
		detectWebLanguageFramework(context) ??
		detectSystemsFramework(context) ??
		detectMobileFramework(context) ??
		detectGenericFramework(context)
	);
}

function detectGenericFramework(
	context: { p: string },
): FrameworkHint | null {
	const { p } = context;
	// ========== GENERIC PATTERNS ==========

	// Any language: index files in API folders
	if (
		p.includes("/api/") &&
		(p.endsWith("/index.ts") ||
			p.endsWith("/index.js") ||
			p.endsWith("/__init__.py"))
	) {
		return { framework: "api", entryPointMultiplier: 1.8, reason: "api-index" };
	}

	// No framework detected - return null for graceful fallback (1.0 multiplier)
	return null;
}

