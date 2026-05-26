/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_NEXUS_SINGLE_REPO?: string;
	readonly VITE_NEXUS_DEFAULT_REPO?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
