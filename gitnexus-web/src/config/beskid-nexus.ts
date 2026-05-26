/** Beskid Nexus product defaults (compiler graph + hosted MCP). */
export const BESKID_NEXUS = {
	/** Registry name from `gitnexus analyze` on the compiler tree. */
	defaultRepo: import.meta.env.VITE_NEXUS_DEFAULT_REPO || 'compiler',
	/** Same-origin API (`gitnexus serve` hosts `/api` and the static UI). */
	apiOrigin: typeof window !== 'undefined' ? window.location.origin : '',
} as const;
