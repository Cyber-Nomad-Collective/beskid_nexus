import { parentPort } from "node:worker_threads";
import { SupportedLanguages } from "gitnexus-shared";
import Parser from "tree-sitter";
import { parseSourceSafe } from "../../../tree-sitter/safe-parse.js";
import {
	getTreeSitterBufferSize,
	getTreeSitterContentByteLength,
	TREE_SITTER_MAX_BUFFER,
} from "../../constants.js";
import { detectFrameworkFromAST } from "../../framework-detection.js";
import { getProvider } from "../../languages/index.js";
import { extractParsedFile } from "../../scope-extractor-bridge.js";
import { buildTypeEnv } from "../../type-env.js";
import type { SyntaxNode } from "../../utils/ast-helpers.js";
import {
	extractTemplateComponents,
	extractVueScript,
} from "../../vue-sfc-extractor.js";
import { generateId } from "../../../../lib/utils.js";
import { logger } from "../../../logger.js";
import { clearCaches } from "./extraction-context.js";
import { extractMatches } from "./match-extraction.js";
import { parser } from "./parser-runtime.js";
import type { ParseWorkerInput, ParseWorkerResult } from "./protocol.js";
import {
	extractLaravelRoutes,
	extractORMQueries,
} from "./routes.js";

export const processFileGroup = (
	files: ParseWorkerInput[],
	language: SupportedLanguages,
	queryString: string,
	result: ParseWorkerResult,
	onFileProcessed?: () => void,
): void => {
	let query: Parser.Query;
	try {
		const lang = parser.getLanguage();
		query = new Parser.Query(lang, queryString);
	} catch (err) {
		const message = `Query compilation failed for ${language}: ${err instanceof Error ? err.message : String(err)}`;
		if (parentPort) {
			parentPort.postMessage({ type: "warning", message });
		} else {
			logger.warn(message);
		}
		return;
	}

	for (const file of files) {
		// Skip files larger than the max tree-sitter buffer (32 MB)
		if (getTreeSitterContentByteLength(file.content) > TREE_SITTER_MAX_BUFFER)
			continue;

		// Vue SFC preprocessing: extract <script> block content
		let parseContent = file.content;
		let lineOffset = 0;
		let isVueSetup = false;
		if (language === SupportedLanguages.Vue) {
			const extracted = extractVueScript(file.content);
			if (!extracted) continue; // skip .vue files with no script block
			parseContent = extracted.scriptContent;
			lineOffset = extracted.lineOffset;
			isVueSetup = extracted.isSetup;
		}

		// Per-language source-text transform (e.g., UE macro stripping for C++).
		// Length-preserving — see LanguageProvider.preprocessSource contract.
		parseContent =
			getProvider(language).preprocessSource?.(parseContent, file.path) ??
			parseContent;

		clearCaches(); // Reset memoization before each new file

		let tree;
		try {
			tree = parseSourceSafe(parser, parseContent, undefined, {
				bufferSize: getTreeSitterBufferSize(parseContent),
			});
		} catch (err) {
			logger.warn(
				`Failed to parse file ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}

		result.fileCount++;
		onFileProcessed?.();

		let matches;
		try {
			matches = query.matches(tree.rootNode);
		} catch (err) {
			logger.warn(
				`Query execution failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}

		const provider = getProvider(language);

		// RFC #909 Ring 2: produce a `ParsedFile` for the new scope-based
		// resolution pipeline. No-op (returns undefined) for every language
		// today — only fires once a provider implements `emitScopeCaptures`.
		// Runs BEFORE legacy extraction and its result is independent: a
		// failure here is caught inside `extractParsedFile` and does NOT
		// affect the legacy DAG path that follows.
		const parsedFile = extractParsedFile(
			provider,
			parseContent,
			file.path,
			(message) => {
				if (parentPort) parentPort.postMessage({ type: "warning", message });
				else logger.warn(message);
			},
			tree,
		);
		if (parsedFile !== undefined) result.parsedFiles.push(parsedFile);

		// Pre-pass: extract heritage from query matches to build parentMap for buildTypeEnv.
		// Heritage edges (EXTENDS/IMPLEMENTS) are created by heritage-processor which runs
		// in PARALLEL with call-processor, so the graph edges don't exist when buildTypeEnv
		// runs. This pre-pass makes parent class information available for type resolution.
		const fileParentMap = new Map<string, string[]>();
		if (provider.heritageExtractor) {
			for (const match of matches) {
				const captureMap: Record<string, SyntaxNode> = {};
				for (const c of match.captures) {
					captureMap[c.name] = c.node;
				}
				if (captureMap["heritage.class"]) {
					const heritageItems = provider.heritageExtractor.extract(captureMap, {
						filePath: file.path,
						language,
					});
					for (const item of heritageItems) {
						if (item.kind === "extends") {
							let parents = fileParentMap.get(item.className);
							if (!parents) {
								parents = [];
								fileParentMap.set(item.className, parents);
							}
							if (!parents.includes(item.parentName)) parents.push(item.parentName);
						}
					}
				}
			}
		}

		// Build per-file type environment + constructor bindings in a single AST walk.
		// Constructor bindings are verified against the SymbolTable in processCallsFromExtracted.
		const parentMap: ReadonlyMap<string, readonly string[]> = fileParentMap;
		const typeEnv = buildTypeEnv(tree, language, {
			parentMap,
			enclosingFunctionFinder: provider?.enclosingFunctionFinder,
			extractFunctionName: provider?.methodExtractor?.extractFunctionName,
		});
		const callRouter = provider.callRouter;

		if (typeEnv.constructorBindings.length > 0) {
			result.constructorBindings.push({
				filePath: file.path,
				bindings: [...typeEnv.constructorBindings],
			});
		}

		// Serialize file-scope bindings for BindingAccumulator. These feed the
		// ExportedTypeMap enrichment loop in pipeline.ts — the only current
		// consumer of worker-path binding data.
		//
		// Historical note: we previously serialized all scopes
		// (`typeEnv.allScopes()`), which pushed ~4.9 MB of function-scope
		// bindings across the IPC boundary on every worker batch with zero
		// downstream readers. Narrowing to `fileScope()` recovers that cost.
		// See the `FileScopeBindings` JSDoc above for the Phase 9 reversion
		// path when a function-scope consumer lands.
		const fileScope = typeEnv.fileScope();
		if (fileScope.size > 0) {
			const scopeBindings: [string, string][] = [];
			for (const [varName, typeName] of fileScope) {
				scopeBindings.push([varName, typeName]);
			}
			result.fileScopeBindings.push({
				filePath: file.path,
				bindings: scopeBindings,
			});
		}

		extractMatches({
			matches,
			file,
			language,
			provider,
			typeEnv,
			callRouter,
			lineOffset,
			isVueSetup,
			result,
		});

		// Extract framework routes via provider detection (e.g., Laravel routes.php)
		if (provider.isRouteFile?.(file.path)) {
			const extractedRoutes = extractLaravelRoutes(tree, file.path);
			for (const r of extractedRoutes) result.routes.push(r);
		}

		// Extract ORM queries (Prisma, Supabase)
		extractORMQueries(file.path, parseContent, result.ormQueries);

		// Vue: emit CALLS edges for components used in <template>
		if (language === SupportedLanguages.Vue) {
			const templateComponents = extractTemplateComponents(file.content);
			for (const componentName of templateComponents) {
				result.calls.push({
					filePath: file.path,
					calledName: componentName,
					sourceId: generateId("File", file.path),
					callForm: "free",
				});
			}
		}
	}
};
