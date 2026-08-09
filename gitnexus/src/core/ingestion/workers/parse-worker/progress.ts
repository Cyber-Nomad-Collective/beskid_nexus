import type { ParseWorkerResult } from "./protocol.js";

// Use a loop instead of push(...spread) to avoid hitting V8's argument limit
// when merging large result sets (push(...arr) calls apply() under the hood
// and blows the stack when arr has >~65k elements).
const appendAll = <T>(target: T[], src: T[]) => {
	for (let i = 0; i < src.length; i++) target.push(src[i]);
};

export const mergeResult = (target: ParseWorkerResult, src: ParseWorkerResult) => {
	appendAll(target.nodes, src.nodes);
	appendAll(target.relationships, src.relationships);
	appendAll(target.symbols, src.symbols);
	appendAll(target.imports, src.imports);
	appendAll(target.calls, src.calls);
	appendAll(target.assignments, src.assignments);
	appendAll(target.heritage, src.heritage);
	appendAll(target.routes, src.routes);
	appendAll(target.fetchCalls, src.fetchCalls);
	appendAll(target.decoratorRoutes, src.decoratorRoutes);
	appendAll(target.toolDefs, src.toolDefs);
	appendAll(target.ormQueries, src.ormQueries);
	appendAll(target.constructorBindings, src.constructorBindings);
	appendAll(target.fileScopeBindings, src.fileScopeBindings);
	appendAll(target.parsedFiles, src.parsedFiles);
	for (const [lang, count] of Object.entries(src.skippedLanguages)) {
		target.skippedLanguages[lang] = (target.skippedLanguages[lang] || 0) + count;
	}
	target.fileCount += src.fileCount;
};
