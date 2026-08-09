// ============================================================================
// TYPES
// ============================================================================

export interface FrameworkHint {
	framework: string;
	entryPointMultiplier: number;
	reason: string;
}

export interface PathFrameworkContext {
	p: string;
	originalPathWithLeadingSlash: string;
}

