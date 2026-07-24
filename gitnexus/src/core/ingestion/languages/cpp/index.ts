/**
 * C++ scope-resolution hooks (RFC #909 Ring 3).
 */

export { cppArityCompatibility } from "./arity.js";
export { emitCppScopeCaptures } from "./captures.js";
export {
	clearFileLocalNames,
	expandCppWildcardNames,
	isFileLocal,
	markFileLocal,
} from "./file-local-linkage.js";
export { splitCppInclude, splitCppUsingDecl } from "./import-decomposer.js";
export { resolveCppImportTarget } from "./import-target.js";
export {
	interpretCppImport,
	interpretCppTypeBinding,
	normalizeCppTypeName,
} from "./interpret.js";
export { cppMergeBindings } from "./merge-bindings.js";
export {
	cppBindingScopeFor,
	cppImportOwningScope,
	cppReceiverBinding,
} from "./simple-hooks.js";
