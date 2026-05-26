/** Beskid Nexus product defaults (compiler graph + hosted MCP). */
export const BESKID_NEXUS = {
	/** Registry name from `gitnexus analyze` on the compiler tree. */
	defaultRepo: import.meta.env.VITE_NEXUS_DEFAULT_REPO || 'compiler',
	/** Same-origin API (nginx proxies `/api` → gitnexus serve). */
	apiOrigin: typeof window !== 'undefined' ? window.location.origin : '',
} as const;
