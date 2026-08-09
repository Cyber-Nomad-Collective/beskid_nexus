export type { ExportedTypeMap } from "./call-processor/context.js";
export {
	buildExportedTypeMapFromGraph,
	buildImportedRawReturnTypes,
	buildImportedReturnTypes,
	seedCrossFileReceiverTypes,
} from "./call-processor/type-inference.js";
export { processCalls } from "./call-processor/collection.js";
export type { OverloadHints } from "./call-processor/overload-path.js";
export { _resolveCallTargetForTesting } from "./call-processor/coordinator.js";
export {
	resolveFreeCall,
	resolveMemberCall,
	resolveStaticCall,
} from "./call-processor/receiver-member.js";
export {
	extractConsumerAccessedKeys,
	extractFetchCallsFromFiles,
	processAssignmentsFromExtracted,
	processCallsFromExtracted,
	processNextjsFetchRoutes,
	processRoutesFromExtracted,
} from "./call-processor/edge-emission.js";
