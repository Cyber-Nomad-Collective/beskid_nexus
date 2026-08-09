export type { RelCsvSplitResult, WriteStreamFactory } from "./lbug-adapter/contracts.js";
export {
	acquireInitLock,
	_initLockPathForTest,
	closeLbug,
	createFTSIndex,
	dropFTSIndex,
	ensureFTSIndex,
	flushWAL,
	initLbug,
	isLbugReady,
	loadFTSExtension,
	loadVectorExtension,
	queryFTS,
	safeClose,
	withLbugDb,
} from "./lbug-adapter/lifecycle-schema.js";
export { getDatabase, isReadOnlyDbError } from "./lbug-adapter/mapping-errors.js";
export {
	executePrepared,
	executeQuery,
	executeWithReusedStatement,
	fetchExistingEmbeddingHashes,
	getEmbeddingTableName,
	getLbugStats,
	loadCachedEmbeddings,
	queryImporters,
	streamQuery,
} from "./lbug-adapter/reads.js";
export type { LbugProgressCallback } from "./lbug-adapter/writes-batching.js";
export {
	batchInsertNodesToLbug,
	deleteAllCommunitiesAndProcesses,
	deleteNodesForFile,
	insertNodeToLbug,
	loadGraphToLbug,
	splitRelCsvByLabelPair,
} from "./lbug-adapter/writes-batching.js";
