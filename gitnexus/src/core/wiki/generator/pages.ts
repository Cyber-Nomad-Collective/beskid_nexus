import fs from "node:fs/promises";
import path from "node:path";
import {
	getAllProcesses,
	getInterModuleCallEdges,
	getInterModuleEdgesForOverview,
	getIntraModuleCallEdges,
	getProcessesForFiles,
} from "../graph-queries.js";
import type { CallLLMOptions, LLMResponse } from "../llm-client.js";
import { estimateTokens } from "../llm-client.js";
import { sanitizeMermaidMarkdown } from "../mermaid-sanitizer.js";
import {
	fillTemplate,
	formatCallEdges,
	formatProcesses,
	MODULE_SYSTEM_PROMPT,
	MODULE_USER_PROMPT,
	OVERVIEW_SYSTEM_PROMPT,
	OVERVIEW_USER_PROMPT,
	PARENT_SYSTEM_PROMPT,
	PARENT_USER_PROMPT,
} from "../prompts.js";
import type { ModuleTreeNode } from "./contracts.js";

interface PageDependencies {
	wikiDir: string;
	maxTokensPerModule?: number;
	repoPath?: string;
	readSourceFiles?: (files: string[]) => Promise<string>;
	truncateSource?: (source: string, maxTokens: number) => string;
	extractModuleFiles?: (tree: ModuleTreeNode[]) => Record<string, string[]>;
	readProjectInfo?: () => Promise<string>;
	invokeLLM: (
		prompt: string,
		systemPrompt: string,
		options?: CallLLMOptions,
	) => Promise<LLMResponse>;
	streamOpts: (label: string, fixedPercent?: number) => CallLLMOptions;
}

export async function generateLeafPage(
	node: ModuleTreeNode,
	deps: Required<
		Pick<
			PageDependencies,
			| "wikiDir"
			| "maxTokensPerModule"
			| "readSourceFiles"
			| "truncateSource"
			| "invokeLLM"
			| "streamOpts"
		>
	>,
): Promise<void> {
	const filePaths = node.files;

	// Read source files from disk
	const sourceCode = await deps.readSourceFiles(filePaths);

	// Token budget check — if too large, summarize in batches
	const totalTokens = estimateTokens(sourceCode);
	let finalSourceCode = sourceCode;
	if (totalTokens > deps.maxTokensPerModule) {
		finalSourceCode = deps.truncateSource(sourceCode, deps.maxTokensPerModule);
	}

	// Get graph data
	const [intraCalls, interCalls, processes] = await Promise.all([
		getIntraModuleCallEdges(filePaths),
		getInterModuleCallEdges(filePaths),
		getProcessesForFiles(filePaths, 5),
	]);

	const prompt = fillTemplate(MODULE_USER_PROMPT, {
		MODULE_NAME: node.name,
		SOURCE_CODE: finalSourceCode,
		INTRA_CALLS: formatCallEdges(intraCalls),
		OUTGOING_CALLS: formatCallEdges(interCalls.outgoing),
		INCOMING_CALLS: formatCallEdges(interCalls.incoming),
		PROCESSES: formatProcesses(processes),
	});

	const response = await deps.invokeLLM(
		prompt,
		MODULE_SYSTEM_PROMPT,
		deps.streamOpts(node.name),
	);

	// Write page with front matter
	const pageContent = sanitizeMermaidMarkdown(
		`# ${node.name}\n\n${response.content}`,
	);
	await fs.writeFile(
		path.join(deps.wikiDir, `${node.slug}.md`),
		pageContent,
		"utf-8",
	);
}

export async function generateParentPage(
	node: ModuleTreeNode,
	deps: Required<Pick<PageDependencies, "wikiDir" | "invokeLLM" | "streamOpts">>,
): Promise<void> {
	if (!node.children || node.children.length === 0) return;

	// Read children's overview sections
	const childDocs: string[] = [];
	for (const child of node.children) {
		const childPage = path.join(deps.wikiDir, `${child.slug}.md`);
		try {
			const content = await fs.readFile(childPage, "utf-8");
			// Extract overview section (first ~500 chars or up to "### Architecture")
			const overviewEnd = content.indexOf("### Architecture");
			const overview =
				overviewEnd > 0
					? content.slice(0, overviewEnd).trim()
					: content.slice(0, 800).trim();
			childDocs.push(`#### ${child.name}\n${overview}`);
		} catch {
			childDocs.push(`#### ${child.name}\n(Documentation not yet generated)`);
		}
	}

	// Get cross-child call edges
	const allChildFiles = node.children.flatMap((c) => c.files);
	const crossCalls = await getIntraModuleCallEdges(allChildFiles);
	const processes = await getProcessesForFiles(allChildFiles, 3);

	const prompt = fillTemplate(PARENT_USER_PROMPT, {
		MODULE_NAME: node.name,
		CHILDREN_DOCS: childDocs.join("\n\n"),
		CROSS_MODULE_CALLS: formatCallEdges(crossCalls),
		CROSS_PROCESSES: formatProcesses(processes),
	});

	const response = await deps.invokeLLM(
		prompt,
		PARENT_SYSTEM_PROMPT,
		deps.streamOpts(node.name),
	);

	const pageContent = sanitizeMermaidMarkdown(
		`# ${node.name}\n\n${response.content}`,
	);
	await fs.writeFile(
		path.join(deps.wikiDir, `${node.slug}.md`),
		pageContent,
		"utf-8",
	);
}

export async function generateOverview(
	moduleTree: ModuleTreeNode[],
	deps: Required<
		Pick<
			PageDependencies,
			| "wikiDir"
			| "repoPath"
			| "extractModuleFiles"
			| "readProjectInfo"
			| "invokeLLM"
			| "streamOpts"
		>
	>,
): Promise<void> {
	// Read module overview sections
	const moduleSummaries: string[] = [];
	for (const node of moduleTree) {
		const pagePath = path.join(deps.wikiDir, `${node.slug}.md`);
		try {
			const content = await fs.readFile(pagePath, "utf-8");
			const overviewEnd = content.indexOf("### Architecture");
			const overview =
				overviewEnd > 0
					? content.slice(0, overviewEnd).trim()
					: content.slice(0, 600).trim();
			moduleSummaries.push(`#### ${node.name}\n${overview}`);
		} catch {
			moduleSummaries.push(`#### ${node.name}\n(Documentation pending)`);
		}
	}

	// Get inter-module edges for architecture diagram
	const moduleFiles = deps.extractModuleFiles(moduleTree);
	const moduleEdges = await getInterModuleEdgesForOverview(moduleFiles);

	// Get top processes for key workflows
	const topProcesses = await getAllProcesses(5);

	// Read project config
	const projectInfo = await deps.readProjectInfo();

	const edgesText =
		moduleEdges.length > 0
			? moduleEdges.map((e) => `${e.from} → ${e.to} (${e.count} calls)`).join("\n")
			: "No inter-module call edges detected";

	const prompt = fillTemplate(OVERVIEW_USER_PROMPT, {
		PROJECT_INFO: projectInfo,
		MODULE_SUMMARIES: moduleSummaries.join("\n\n"),
		MODULE_EDGES: edgesText,
		TOP_PROCESSES: formatProcesses(topProcesses),
	});

	const response = await deps.invokeLLM(
		prompt,
		OVERVIEW_SYSTEM_PROMPT,
		deps.streamOpts("Generating overview", 88),
	);

	const pageContent = sanitizeMermaidMarkdown(
		`# ${path.basename(deps.repoPath)} — Wiki\n\n${response.content}`,
	);
	await fs.writeFile(
		path.join(deps.wikiDir, "overview.md"),
		pageContent,
		"utf-8",
	);
}
