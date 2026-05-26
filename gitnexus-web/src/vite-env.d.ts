/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_NEXUS_DEFAULT_REPO?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
