/**
 * Go scope-resolution hooks (RFC #909 Ring 3).
 */

export { goArityCompatibility } from "./arity.js";
export {
	getGoCaptureCacheStats,
	resetGoCaptureCacheStats,
} from "./cache-stats.js";
export { emitGoScopeCaptures } from "./captures.js";
export { splitGoImportStatement } from "./import-decomposer.js";
export {
	type GoResolveContext,
	resolveGoImportTarget,
} from "./import-target.js";
export { detectGoInterfaceImplementations } from "./interface-impls.js";
export {
	interpretGoImport,
	interpretGoTypeBinding,
	normalizeGoTypeName,
} from "./interpret.js";
export { goMergeBindings } from "./merge-bindings.js";
export { mirrorGoNamespaceTypeBindings } from "./namespace-mirror.js";
export { populateGoPackageSiblings } from "./package-siblings.js";
export { populateGoRangeBindings } from "./range-binding.js";
export { synthesizeGoReceiverBinding } from "./receiver-binding.js";
export {
	goBindingScopeFor,
	goImportOwningScope,
	goReceiverBinding,
} from "./simple-hooks.js";
export { synthesizeGoTypeBindings } from "./type-binding.js";
