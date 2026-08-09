import { getLanguageFromFilename, SupportedLanguages } from "gitnexus-shared";
import { getProvider } from "../../languages/index.js";
import { processFileGroup } from "./extraction.js";
import { isLanguageAvailable, setLanguage } from "./parser-runtime.js";
import type { ParseWorkerInput, ParseWorkerResult } from "./protocol.js";

// ============================================================================
// Process a batch of files
// ============================================================================

export const processBatch = (
	files: ParseWorkerInput[],
	onProgress?: (filesProcessed: number) => void,
): ParseWorkerResult => {
	const result: ParseWorkerResult = {
		nodes: [],
		relationships: [],
		symbols: [],
		imports: [],
		calls: [],
		assignments: [],
		heritage: [],
		routes: [],
		fetchCalls: [],
		decoratorRoutes: [],
		toolDefs: [],
		ormQueries: [],
		constructorBindings: [],
		fileScopeBindings: [],
		parsedFiles: [],
		skippedLanguages: {},
		fileCount: 0,
	};

	// Group by language to minimize setLanguage calls
	const byLanguage = new Map<SupportedLanguages, ParseWorkerInput[]>();
	for (const file of files) {
		const lang = getLanguageFromFilename(file.path);
		if (!lang) continue;
		let list = byLanguage.get(lang);
		if (!list) {
			list = [];
			byLanguage.set(lang, list);
		}
		list.push(file);
	}

	let totalProcessed = 0;
	let lastReported = 0;
	const PROGRESS_INTERVAL = Math.max(
		1,
		Math.min(100, Math.ceil(files.length / 10)),
	);

	const onFileProcessed = onProgress
		? () => {
				totalProcessed++;
				if (totalProcessed - lastReported >= PROGRESS_INTERVAL) {
					lastReported = totalProcessed;
					onProgress(totalProcessed);
				}
			}
		: undefined;

	for (const [language, langFiles] of byLanguage) {
		const provider = getProvider(language);
		const queryString = provider.treeSitterQueries;
		if (!queryString) continue;

		// Track if we need to handle tsx separately
		const tsxFiles: ParseWorkerInput[] = [];
		const regularFiles: ParseWorkerInput[] = [];

		if (language === SupportedLanguages.TypeScript) {
			for (const f of langFiles) {
				if (f.path.endsWith(".tsx")) {
					tsxFiles.push(f);
				} else {
					regularFiles.push(f);
				}
			}
		} else {
			// Manual loop (not spread) — `push(...arr)` blows the stack on very
			// large arrays when langFiles has tens of thousands of entries.
			for (const f of langFiles) regularFiles.push(f);
		}

		// Process regular files for this language
		if (regularFiles.length > 0) {
			if (isLanguageAvailable(language, regularFiles[0].path)) {
				try {
					setLanguage(language, regularFiles[0].path);
					processFileGroup(
						regularFiles,
						language,
						queryString,
						result,
						onFileProcessed,
					);
				} catch {
					// parser unavailable — skip this language group
				}
			} else {
				result.skippedLanguages[language] =
					(result.skippedLanguages[language] || 0) + regularFiles.length;
			}
		}

		// Process tsx files separately (different grammar)
		if (tsxFiles.length > 0) {
			if (isLanguageAvailable(language, tsxFiles[0].path)) {
				try {
					setLanguage(language, tsxFiles[0].path);
					processFileGroup(tsxFiles, language, queryString, result, onFileProcessed);
				} catch {
					// parser unavailable — skip this language group
				}
			} else {
				result.skippedLanguages[language] =
					(result.skippedLanguages[language] || 0) + tsxFiles.length;
			}
		}
	}

	if (onProgress && totalProcessed !== lastReported) {
		onProgress(totalProcessed);
	}

	return result;
};
