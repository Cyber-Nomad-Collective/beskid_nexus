/**
 * Wiki Generator
 *
 * Orchestrates the full wiki generation pipeline:
 *   Phase 0: Validate prerequisites + gather graph structure
 *   Phase 1: Build module tree (one LLM call)
 *   Phase 2: Generate module pages (one LLM call per module, bottom-up)
 *   Phase 3: Generate overview page
 *
 * Supports incremental updates via git diff + module-file mapping.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { shouldIgnorePath } from "../../../config/ignore-service.js";
import { callCursorLLM, resolveCursorConfig } from "../cursor-client.js";
import {
	closeWikiDb,
	type FileWithExports,
	getAllFiles,
	getFilesWithExports,
	initWikiDb,
	touchWikiDb,
} from "../graph-queries.js";
import { generateHTMLViewer } from "../html-viewer.js";
import {
	type CallLLMOptions,
	callLLM,
	type LLMConfig,
	type LLMResponse,
} from "../llm-client.js";
import {
	fillTemplate,
	formatDirectoryTree,
	formatFileListForGrouping,
	GROUPING_SYSTEM_PROMPT,
	GROUPING_USER_PROMPT,
} from "../prompts.js";

import type {
	ModuleTreeNode,
	ProgressCallback,
	WikiMeta,
	WikiOptions,
	WikiRunResult,
} from "./contracts.js";
import {
	fallbackGrouping,
	parseGroupingResponse,
	splitBySubdirectory,
} from "./grouping.js";
import {
	countModules,
	estimateModuleTokens,
	extractModuleFiles,
	flattenModuleTree,
	getChangedFiles,
	getCurrentCommit,
	isCommitReachable,
	readProjectInfo,
	readSourceFiles,
	truncateSource,
} from "./helpers.js";
import {
	fileExists,
	loadWikiMeta,
	saveModuleTree,
	saveWikiMeta,
} from "./output.js";
import {
	generateLeafPage,
	generateOverview,
	generateParentPage,
} from "./pages.js";
import { runParallel } from "./parallel.js";

const DEFAULT_MAX_TOKENS_PER_MODULE = 30_000;
const WIKI_DIR = "wiki";

// ─── Generator Class ──────────────────────────────────────────────────

export class WikiGenerator {
	private repoPath: string;
	private storagePath: string;
	private wikiDir: string;
	private lbugPath: string;
	private llmConfig: LLMConfig;
	private maxTokensPerModule: number;
	private concurrency: number;
	private options: WikiOptions;
	private onProgress: ProgressCallback;
	private failedModules: string[] = [];

	constructor(
		repoPath: string,
		storagePath: string,
		lbugPath: string,
		llmConfig: LLMConfig,
		options: WikiOptions = {},
		onProgress?: ProgressCallback,
	) {
		this.repoPath = repoPath;
		this.storagePath = storagePath;
		this.wikiDir = path.join(storagePath, WIKI_DIR);
		this.lbugPath = lbugPath;
		this.options = options;
		this.llmConfig = llmConfig;
		this.maxTokensPerModule =
			options.maxTokensPerModule ?? DEFAULT_MAX_TOKENS_PER_MODULE;
		this.concurrency = options.concurrency ?? 3;
		const progressFn = onProgress || (() => {});
		this.onProgress = (phase, percent, detail) => {
			if (percent > 0) this.lastPercent = percent;
			progressFn(phase, percent, detail);
		};
	}

	private lastPercent = 0;

	/**
	 * Create streaming options that report LLM progress to the progress bar.
	 *
	 * Progress calculation:
	 * - If fixedPercent is provided, we show incremental progress within that phase
	 *   based on token generation (e.g., grouping at 15% → 15-28%)
	 * - If fixedPercent is NOT provided, we only update the label with token count
	 *   but keep the current percentage (avoids fluctuation during module generation)
	 *
	 * Also touches the DB connection periodically to prevent idle timeout.
	 */
	private streamOpts(
		label: string,
		fixedPercent?: number,
		percentRange = 10,
	): CallLLMOptions {
		const hasFixedStart = fixedPercent !== undefined;
		const startPercent = fixedPercent ?? this.lastPercent;
		const expectedTokens = 2000;
		let lastTouch = Date.now();

		return {
			onChunk: (chars: number) => {
				const tokens = Math.round(chars / 4);

				if (hasFixedStart) {
					// For fixed phases (like grouping), show incremental progress
					const progress = Math.min(1, tokens / expectedTokens);
					const pct = Math.round(startPercent + progress * percentRange);
					this.onProgress("stream", pct, `${label} (${tokens} tok)`);
				} else {
					// For module generation, only update the label, keep current percent
					this.onProgress("stream", this.lastPercent, `${label} (${tokens} tok)`);
				}

				// Touch DB every 60s to prevent idle timeout during long LLM calls
				const now = Date.now();
				if (now - lastTouch > 60_000) {
					touchWikiDb();
					lastTouch = now;
				}
			},
		};
	}

	/**
	 * Route LLM call to the appropriate provider (OpenAI-compatible or Cursor CLI).
	 */
	private async invokeLLM(
		prompt: string,
		systemPrompt: string,
		options?: CallLLMOptions,
	): Promise<LLMResponse> {
		if (this.llmConfig.provider === "cursor") {
			const cursorConfig = resolveCursorConfig({
				model: this.llmConfig.model,
				workingDirectory: this.repoPath,
			});
			return callCursorLLM(prompt, cursorConfig, systemPrompt, options);
		}
		return callLLM(prompt, this.llmConfig, systemPrompt, options);
	}

	/**
	 * Main entry point. Runs the full pipeline or incremental update.
	 */
	async run(): Promise<WikiRunResult> {
		await fs.mkdir(this.wikiDir, { recursive: true });

		const existingMeta = await this.loadWikiMeta();
		const currentCommit = this.getCurrentCommit();
		const forceMode = this.options.force;

		// Up-to-date check (skip if --force)
		if (!forceMode && existingMeta && existingMeta.fromCommit === currentCommit) {
			// Still regenerate the HTML viewer in case it's missing
			await this.ensureHTMLViewer();
			return { pagesGenerated: 0, mode: "up-to-date", failedModules: [] };
		}

		// Force mode: delete snapshot to force full re-grouping
		if (forceMode) {
			try {
				await fs.unlink(path.join(this.wikiDir, "first_module_tree.json"));
			} catch {}
			// Delete existing module pages so they get regenerated
			const existingFiles = await fs
				.readdir(this.wikiDir)
				.catch(() => [] as string[]);
			for (const f of existingFiles) {
				if (f.endsWith(".md")) {
					try {
						await fs.unlink(path.join(this.wikiDir, f));
					} catch {}
				}
			}
		}

		// Init graph
		this.onProgress("init", 2, "Connecting to knowledge graph...");
		await initWikiDb(this.lbugPath);

		let result: WikiRunResult;
		try {
			if (!forceMode && existingMeta && existingMeta.fromCommit) {
				result = await this.incrementalUpdate(existingMeta, currentCommit);
			} else {
				result = await this.fullGeneration(currentCommit);
			}
		} finally {
			await closeWikiDb();
		}

		// Always generate the HTML viewer after wiki content changes
		await this.ensureHTMLViewer();

		return result;
	}

	// ─── HTML Viewer ─────────────────────────────────────────────────────

	private async ensureHTMLViewer(): Promise<void> {
		// Only generate if there are markdown pages to bundle
		const dirEntries = await fs.readdir(this.wikiDir).catch(() => [] as string[]);
		const hasMd = dirEntries.some((f) => f.endsWith(".md"));
		if (!hasMd) return;

		this.onProgress("html", 98, "Building HTML viewer...");
		const repoName = path.basename(this.repoPath);
		await generateHTMLViewer(this.wikiDir, repoName);
	}

	// ─── Full Generation ────────────────────────────────────────────────

	private async fullGeneration(currentCommit: string): Promise<WikiRunResult> {
		let pagesGenerated = 0;

		// Phase 0: Gather structure
		this.onProgress("gather", 5, "Querying graph for file structure...");
		const filesWithExports = await getFilesWithExports();
		const allFiles = await getAllFiles();

		// Filter to source files only
		const sourceFiles = allFiles.filter((f) => !shouldIgnorePath(f));
		if (sourceFiles.length === 0) {
			throw new Error(
				"No source files found in the knowledge graph. Nothing to document.",
			);
		}

		// Build enriched file list (merge exports into all source files)
		const exportMap = new Map(filesWithExports.map((f) => [f.filePath, f]));
		const enrichedFiles: FileWithExports[] = sourceFiles.map((fp) => {
			return exportMap.get(fp) || { filePath: fp, symbols: [] };
		});

		this.onProgress("gather", 10, `Found ${sourceFiles.length} source files`);

		// Phase 1: Build module tree
		const moduleTree = await this.buildModuleTree(enrichedFiles);
		pagesGenerated = 0;

		// If reviewOnly mode, save tree and stop for user to review/edit
		if (this.options.reviewOnly) {
			await this.saveModuleTree(moduleTree);
			this.onProgress("review", 30, "Module tree ready for review");
			const reviewResult: WikiRunResult = {
				pagesGenerated: 0,
				mode: "full",
				failedModules: [],
				moduleTree,
			};
			return reviewResult;
		}

		// Phase 2: Generate module pages (parallel with concurrency limit)
		const totalModules = this.countModules(moduleTree);
		let modulesProcessed = 0;

		const reportProgress = (moduleName?: string) => {
			modulesProcessed++;
			const percent = 30 + Math.round((modulesProcessed / totalModules) * 55);
			const detail = moduleName
				? `${modulesProcessed}/${totalModules} — ${moduleName}`
				: `${modulesProcessed}/${totalModules} modules`;
			this.onProgress("modules", percent, detail);
		};

		// Flatten tree into layers: leaves first, then parents
		// Leaves can run in parallel; parents must wait for their children
		const { leaves, parents } = this.flattenModuleTree(moduleTree);

		// Process all leaf modules in parallel
		pagesGenerated += await this.runParallel(leaves, async (node) => {
			const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
			if (await this.fileExists(pagePath)) {
				reportProgress(node.name);
				return 0;
			}
			try {
				await this.generateLeafPage(node);
				reportProgress(node.name);
				return 1;
			} catch (_err: any) {
				this.failedModules.push(node.name);
				reportProgress(`Failed: ${node.name}`);
				return 0;
			}
		});

		// Process parent modules sequentially (they depend on child docs)
		for (const node of parents) {
			const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
			if (await this.fileExists(pagePath)) {
				reportProgress(node.name);
				continue;
			}
			try {
				await this.generateParentPage(node);
				pagesGenerated++;
				reportProgress(node.name);
			} catch (_err: any) {
				this.failedModules.push(node.name);
				reportProgress(`Failed: ${node.name}`);
			}
		}

		// Phase 3: Generate overview
		this.onProgress("overview", 88, "Generating overview page...");
		await this.generateOverview(moduleTree);
		pagesGenerated++;

		// Save metadata
		this.onProgress("finalize", 95, "Saving metadata...");
		const moduleFiles = this.extractModuleFiles(moduleTree);
		await this.saveModuleTree(moduleTree);
		await this.saveWikiMeta({
			fromCommit: currentCommit,
			generatedAt: new Date().toISOString(),
			model: this.llmConfig.model,
			moduleFiles,
			moduleTree,
		});

		this.onProgress("done", 100, "Wiki generation complete");
		return {
			pagesGenerated,
			mode: "full",
			failedModules: [...this.failedModules],
		};
	}

	// ─── Phase 1: Build Module Tree ────────────────────────────────────

	private async buildModuleTree(
		files: FileWithExports[],
	): Promise<ModuleTreeNode[]> {
		// First, check for user-edited module_tree.json (from --review workflow)
		const editablePath = path.join(this.wikiDir, "module_tree.json");
		try {
			const edited = await fs.readFile(editablePath, "utf-8");
			const parsed = JSON.parse(edited);
			if (Array.isArray(parsed) && parsed.length > 0) {
				this.onProgress("grouping", 25, "Using edited module tree");
				return parsed;
			}
		} catch {
			// No edited tree, check for original snapshot
		}

		// Check for existing immutable snapshot (resumability)
		const snapshotPath = path.join(this.wikiDir, "first_module_tree.json");
		try {
			const existing = await fs.readFile(snapshotPath, "utf-8");
			const parsed = JSON.parse(existing);
			if (Array.isArray(parsed) && parsed.length > 0) {
				this.onProgress("grouping", 25, "Using existing module tree (resuming)");
				return parsed;
			}
		} catch {
			// No snapshot, generate new
		}

		this.onProgress("grouping", 15, "Grouping files into modules (LLM)...");

		const fileList = formatFileListForGrouping(files);
		const dirTree = formatDirectoryTree(files.map((f) => f.filePath));

		const prompt = fillTemplate(GROUPING_USER_PROMPT, {
			FILE_LIST: fileList,
			DIRECTORY_TREE: dirTree,
		});

		const response = await this.invokeLLM(
			prompt,
			GROUPING_SYSTEM_PROMPT,
			this.streamOpts("Grouping files", 15, 13),
		);
		const grouping = this.parseGroupingResponse(response.content, files);

		// Convert to tree nodes
		const tree: ModuleTreeNode[] = [];
		for (const [moduleName, modulePaths] of Object.entries(grouping)) {
			const slug = this.slugify(moduleName);
			const node: ModuleTreeNode = { name: moduleName, slug, files: modulePaths };

			// Token budget check — split if too large
			const totalTokens = await this.estimateModuleTokens(modulePaths);
			if (totalTokens > this.maxTokensPerModule && modulePaths.length > 3) {
				const children = this.splitBySubdirectory(moduleName, modulePaths);
				// Only create hierarchy if we actually got multiple children
				// If splitting results in 1 child, keep files flat (avoid redundant nesting)
				if (children.length > 1) {
					node.children = children;
					node.files = []; // Parent doesn't own files directly when split
				}
				// If only 1 child, keep original flat structure (files stay in node.files)
			}

			tree.push(node);
		}

		// Save immutable snapshot for resumability
		await fs.writeFile(snapshotPath, JSON.stringify(tree, null, 2), "utf-8");
		this.onProgress("grouping", 28, `Created ${tree.length} modules`);

		return tree;
	}

	/**
	 * Parse LLM grouping response. Validates all files are assigned.
	 */
	private parseGroupingResponse(
		content: string,
		files: FileWithExports[],
	): Record<string, string[]> {
		return parseGroupingResponse(content, files);
	}

	/**
	 * Fallback grouping by top-level directory when LLM parsing fails.
	 */
	private fallbackGrouping(files: FileWithExports[]): Record<string, string[]> {
		return fallbackGrouping(files);
	}

	/**
	 * Split a large module into sub-modules by subdirectory.
	 * Uses the full subDir path for naming to avoid slug collisions
	 * (e.g., "synapse-screen/src" vs "synapse-core/src").
	 */
	private splitBySubdirectory(
		moduleName: string,
		files: string[],
	): ModuleTreeNode[] {
		return splitBySubdirectory(moduleName, files, (name) => this.slugify(name));
	}

	// ─── Phase 2: Generate Module Pages ─────────────────────────────────

	/**
	 * Generate a leaf module page from source code + graph data.
	 */
	private async generateLeafPage(node: ModuleTreeNode): Promise<void> {
		return generateLeafPage(node, {
			wikiDir: this.wikiDir,
			maxTokensPerModule: this.maxTokensPerModule,
			readSourceFiles: (files) => this.readSourceFiles(files),
			truncateSource: (source, maxTokens) =>
				this.truncateSource(source, maxTokens),
			invokeLLM: (prompt, systemPrompt, options) =>
				this.invokeLLM(prompt, systemPrompt, options),
			streamOpts: (label, fixedPercent) => this.streamOpts(label, fixedPercent),
		});
	}

	/**
	 * Generate a parent module page from children's documentation.
	 */
	private async generateParentPage(node: ModuleTreeNode): Promise<void> {
		return generateParentPage(node, {
			wikiDir: this.wikiDir,
			invokeLLM: (prompt, systemPrompt, options) =>
				this.invokeLLM(prompt, systemPrompt, options),
			streamOpts: (label, fixedPercent) => this.streamOpts(label, fixedPercent),
		});
	}

	// ─── Phase 3: Generate Overview ─────────────────────────────────────

	private async generateOverview(moduleTree: ModuleTreeNode[]): Promise<void> {
		return generateOverview(moduleTree, {
			wikiDir: this.wikiDir,
			repoPath: this.repoPath,
			extractModuleFiles: (tree) => this.extractModuleFiles(tree),
			readProjectInfo: () => this.readProjectInfo(),
			invokeLLM: (prompt, systemPrompt, options) =>
				this.invokeLLM(prompt, systemPrompt, options),
			streamOpts: (label, fixedPercent) => this.streamOpts(label, fixedPercent),
		});
	}

	// ─── Incremental Updates ────────────────────────────────────────────

	private async incrementalUpdate(
		existingMeta: WikiMeta,
		currentCommit: string,
	): Promise<WikiRunResult> {
		this.onProgress("incremental", 5, "Detecting changes...");

		// Get changed files since last generation
		const changedFiles = this.getChangedFiles(
			existingMeta.fromCommit,
			currentCommit,
		);

		// If null, commits are on divergent branches (e.g., wiki generated on feature branch,
		// now running on main). Fall back to full generation.
		if (changedFiles === null) {
			this.onProgress(
				"incremental",
				10,
				"Branch diverged, running full generation...",
			);
			const fullResult = await this.fullGeneration(currentCommit);
			return { ...fullResult, mode: "incremental" };
		}

		if (changedFiles.length === 0) {
			// No file changes but commit differs (e.g. merge commit)
			await this.saveWikiMeta({
				...existingMeta,
				fromCommit: currentCommit,
				generatedAt: new Date().toISOString(),
			});
			return { pagesGenerated: 0, mode: "incremental", failedModules: [] };
		}

		this.onProgress("incremental", 10, `${changedFiles.length} files changed`);

		// Determine affected modules
		const affectedModules = new Set<string>();
		const newFiles: string[] = [];

		for (const fp of changedFiles) {
			let found = false;
			for (const [mod, files] of Object.entries(existingMeta.moduleFiles)) {
				if (files.includes(fp)) {
					affectedModules.add(mod);
					found = true;
					break;
				}
			}
			if (!found && !shouldIgnorePath(fp)) {
				newFiles.push(fp);
			}
		}

		// If significant new files exist, re-run full grouping
		if (newFiles.length > 5) {
			this.onProgress(
				"incremental",
				15,
				"Significant new files detected, running full generation...",
			);
			// Delete old snapshot to force re-grouping
			try {
				await fs.unlink(path.join(this.wikiDir, "first_module_tree.json"));
			} catch {}
			const fullResult = await this.fullGeneration(currentCommit);
			return { ...fullResult, mode: "incremental" };
		}

		// Add new files to nearest module or "Other"
		if (newFiles.length > 0) {
			if (!existingMeta.moduleFiles.Other) {
				existingMeta.moduleFiles.Other = [];
			}
			existingMeta.moduleFiles.Other.push(...newFiles);
			affectedModules.add("Other");
		}

		// Regenerate affected module pages (parallel)
		let pagesGenerated = 0;
		const moduleTree = existingMeta.moduleTree;
		const affectedArray = Array.from(affectedModules);

		this.onProgress(
			"incremental",
			20,
			`Regenerating ${affectedArray.length} module(s)...`,
		);

		const affectedNodes: ModuleTreeNode[] = [];
		for (const mod of affectedArray) {
			const modSlug = this.slugify(mod);
			const node = this.findNodeBySlug(moduleTree, modSlug);
			if (node) {
				try {
					await fs.unlink(path.join(this.wikiDir, `${node.slug}.md`));
				} catch {}
				affectedNodes.push(node);
			}
		}

		let incProcessed = 0;
		pagesGenerated += await this.runParallel(affectedNodes, async (node) => {
			try {
				if (node.children && node.children.length > 0) {
					await this.generateParentPage(node);
				} else {
					await this.generateLeafPage(node);
				}
				incProcessed++;
				const percent = 20 + Math.round((incProcessed / affectedNodes.length) * 60);
				this.onProgress(
					"incremental",
					percent,
					`${incProcessed}/${affectedNodes.length} — ${node.name}`,
				);
				return 1;
			} catch (_err: any) {
				this.failedModules.push(node.name);
				incProcessed++;
				return 0;
			}
		});

		// Regenerate overview if any pages changed
		if (pagesGenerated > 0) {
			this.onProgress("incremental", 85, "Updating overview...");
			await this.generateOverview(moduleTree);
			pagesGenerated++;
		}

		// Save updated metadata
		this.onProgress("incremental", 95, "Saving metadata...");
		await this.saveWikiMeta({
			...existingMeta,
			fromCommit: currentCommit,
			generatedAt: new Date().toISOString(),
			model: this.llmConfig.model,
		});

		this.onProgress("done", 100, "Incremental update complete");
		return {
			pagesGenerated,
			mode: "incremental",
			failedModules: [...this.failedModules],
		};
	}

	// ─── Helpers ────────────────────────────────────────────────────────

	private getCurrentCommit(): string {
		return getCurrentCommit(this.repoPath);
	}

	/**
	 * Check if fromCommit is an ancestor of toCommit (reachable in git history).
	 * Returns false if commits are on divergent branches or fromCommit doesn't exist.
	 */
	private isCommitReachable(fromCommit: string, toCommit: string): boolean {
		return isCommitReachable(this.repoPath, fromCommit, toCommit);
	}

	private getChangedFiles(
		fromCommit: string,
		toCommit: string,
	): string[] | null {
		return getChangedFiles(this.repoPath, fromCommit, toCommit);
	}

	private async readSourceFiles(filePaths: string[]): Promise<string> {
		return readSourceFiles(this.repoPath, filePaths);
	}

	private truncateSource(source: string, maxTokens: number): string {
		return truncateSource(source, maxTokens);
	}

	private async estimateModuleTokens(filePaths: string[]): Promise<number> {
		return estimateModuleTokens(this.repoPath, filePaths);
	}

	private async readProjectInfo(): Promise<string> {
		return readProjectInfo(this.repoPath);
	}

	private extractModuleFiles(tree: ModuleTreeNode[]): Record<string, string[]> {
		return extractModuleFiles(tree);
	}

	private countModules(tree: ModuleTreeNode[]): number {
		return countModules(tree);
	}

	/**
	 * Flatten the module tree into leaf nodes and parent nodes.
	 * Leaves can be processed in parallel; parents must wait for children.
	 */
	private flattenModuleTree(tree: ModuleTreeNode[]): {
		leaves: ModuleTreeNode[];
		parents: ModuleTreeNode[];
	} {
		return flattenModuleTree(tree);
	}

	/**
	 * Run async tasks in parallel with a concurrency limit and adaptive rate limiting.
	 * If a 429 rate limit is hit, concurrency is temporarily reduced.
	 */
	private async runParallel<T>(
		items: T[],
		fn: (item: T) => Promise<number>,
	): Promise<number> {
		return runParallel(
			items,
			fn,
			this.concurrency,
			this.onProgress,
			() => this.lastPercent,
		);
	}

	private findNodeBySlug(
		tree: ModuleTreeNode[],
		slug: string,
	): ModuleTreeNode | null {
		for (const node of tree) {
			if (node.slug === slug) return node;
			if (node.children) {
				const found = this.findNodeBySlug(node.children, slug);
				if (found) return found;
			}
		}
		return null;
	}

	private slugify(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60);
	}

	private async fileExists(fp: string): Promise<boolean> {
		return fileExists(fp);
	}

	private async loadWikiMeta(): Promise<WikiMeta | null> {
		return loadWikiMeta(this.wikiDir);
	}

	private async saveWikiMeta(meta: WikiMeta): Promise<void> {
		await saveWikiMeta(this.wikiDir, meta);
	}

	private async saveModuleTree(tree: ModuleTreeNode[]): Promise<void> {
		await saveModuleTree(this.wikiDir, tree);
	}
}
