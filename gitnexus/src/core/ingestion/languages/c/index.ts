/**
 * C scope-resolution hooks (RFC #909 Ring 3).
 */

export { cArityCompatibility } from "./arity.js";
export { emitCScopeCaptures } from "./captures.js";
export { splitCInclude } from "./import-decomposer.js";
export { resolveCImportTarget } from "./import-target.js";
export {
	interpretCImport,
	interpretCTypeBinding,
	normalizeCTypeName,
} from "./interpret.js";
export { cMergeBindings } from "./merge-bindings.js";
export {
	cBindingScopeFor,
	cImportOwningScope,
	cReceiverBinding,
} from "./simple-hooks.js";
export {
	clearStaticNames,
	expandCWildcardNames,
	isStaticName,
	markStaticName,
} from "./static-linkage.js";
