/**
 * Repository Manager
 *
 * Manages GitNexus index storage in .gitnexus/ at repo root.
 * Also maintains a global registry at ~/.gitnexus/registry.json.
 */
export {
	INCREMENTAL_SCHEMA_VERSION,
} from "./repo-manager/contracts.js";
export type {
	CLIConfig,
	CwdMatch,
	IndexedRepo,
	RegisterRepoOptions,
	RegistryEntry,
	RepoMeta,
} from "./repo-manager/contracts.js";
export {
	AnalysisNotFinalizedError,
	RegistryAmbiguousTargetError,
	RegistryNameCollisionError,
	RegistryNotFoundError,
	UnsafeStoragePathError,
} from "./repo-manager/errors.js";
export {
	ensureGitNexusIgnored,
} from "./repo-manager/ignore.js";
export {
	cleanupOldKuzuFiles,
	findRepo,
	hasIndex,
	hasKuzuIndex,
	loadCLIConfig,
	loadMeta,
	loadRepo,
	saveCLIConfig,
	saveMeta,
} from "./repo-manager/metadata-index.js";
export {
	canonicalizePath,
	getCloneRoot,
	getGlobalConfigPath,
	getGlobalDir,
	getGlobalRegistryPath,
	getStoragePath,
	getStoragePaths,
} from "./repo-manager/paths.js";
export {
	assertAnalysisFinalized,
	assertSafeStoragePath,
	findSiblingClones,
	listRegisteredRepos,
	readRegistry,
	registerRepo,
	resolveRegistryEntry,
	unregisterRepo,
} from "./repo-manager/registry.js";
