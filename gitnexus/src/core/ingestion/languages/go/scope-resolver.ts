import type { ParsedFile } from "gitnexus-shared";
import { SupportedLanguages } from "gitnexus-shared";
import { loadGoModulePath } from "../../language-config.js";
import type { ScopeResolver } from "../../scope-resolution/contract/scope-resolver.js";
import {
	buildMro,
	defaultLinearize,
} from "../../scope-resolution/passes/mro.js";
import { goProvider } from "../go.js";
import { expandGoWildcardNames } from "./expand-wildcards.js";
import {
	goArityCompatibility,
	goMergeBindings,
	mirrorGoNamespaceTypeBindings,
	populateGoPackageSiblings,
	resolveGoImportTarget,
} from "./index.js";
import { detectGoInterfaceImplementations } from "./interface-impls.js";
import {
	populateGoOwners,
	populateGoWorkspaceOwners,
} from "./method-owners.js";
import { populateGoRangeBindings } from "./range-binding.js";

export const goScopeResolver: ScopeResolver = {
	language: SupportedLanguages.Go,
	languageProvider: goProvider,
	importEdgeReason: "go-scope: import",

	loadResolutionConfig: (repoPath: string) => loadGoModulePath(repoPath),

	resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
		resolveGoImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

	expandsWildcardTo: (targetModuleScope, parsedFiles) =>
		expandGoWildcardNames(targetModuleScope, parsedFiles),

	mergeBindings: (existing, incoming, scopeId) =>
		goMergeBindings(existing, incoming, scopeId),

	arityCompatibility: (callsite, def) => goArityCompatibility(def, callsite),

	buildMro: (graph, parsedFiles, nodeLookup) =>
		buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

	populateOwners: (parsed: ParsedFile) => populateGoOwners(parsed),
	populateWorkspaceOwners: (parsedFiles, ctx) =>
		populateGoWorkspaceOwners(parsedFiles, ctx),

	isSuperReceiver: () => false,

	fieldFallbackOnMethodLookup: false,
	hoistTypeBindingsToModule: true,
	propagatesReturnTypesAcrossImports: true,
	allowGlobalFreeCallFallback: true,

	populateNamespaceSiblings: populateGoPackageSiblings,
	mirrorNamespaceTypeBindings: mirrorGoNamespaceTypeBindings,
	// Staged/V2: registered but not yet wired in run.ts — method-name-only
	// matching produces false IMPLEMENTS edges; awaits signature-level comparison.
	detectInterfaceImplementations: detectGoInterfaceImplementations,
	populateRangeBindings: populateGoRangeBindings,
};
