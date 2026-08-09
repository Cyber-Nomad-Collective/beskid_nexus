export interface WikiOptions {
	force?: boolean;
	maxTokensPerModule?: number;
	concurrency?: number;
	/** If true, stop after building module tree for user review */
	reviewOnly?: boolean;
}

export interface WikiMeta {
	fromCommit: string;
	generatedAt: string;
	model: string;
	moduleFiles: Record<string, string[]>;
	moduleTree: ModuleTreeNode[];
}

export interface ModuleTreeNode {
	name: string;
	slug: string;
	files: string[];
	children?: ModuleTreeNode[];
}

export type ProgressCallback = (
	phase: string,
	percent: number,
	detail?: string,
) => void;

export interface WikiRunResult {
	pagesGenerated: number;
	mode: "full" | "incremental" | "up-to-date";
	failedModules: string[];
	moduleTree?: ModuleTreeNode[];
}
