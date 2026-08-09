import { SupportedLanguages, type NodeLabel, type ParsedFile } from "gitnexus-shared";
import type { ExtractedHeritage } from "../../model/heritage-map.js";
import type { NamedBinding } from "../../named-bindings/types.js";
import type { ConstructorBinding } from "../../type-env.js";
import type { MixedChainStep } from "../../utils/call-analysis.js";

// ============================================================================
// Types for serializable results
// ============================================================================

interface ParsedNode {
	id: string;
	label: string;
	properties: {
		name: string;
		filePath: string;
		startLine: number;
		endLine: number;
		language: SupportedLanguages;
		isExported: boolean;
		astFrameworkMultiplier?: number;
		astFrameworkReason?: string;
		description?: string;
		// Method/field metadata — extensible via buildMethodProps spread
		[key: string]: unknown;
	};
}

interface ParsedRelationship {
	id: string;
	sourceId: string;
	targetId: string;
	type: "DEFINES" | "HAS_METHOD" | "HAS_PROPERTY";
	confidence: number;
	reason: string;
}

interface ParsedSymbol {
	filePath: string;
	name: string;
	nodeId: string;
	type: NodeLabel;
	qualifiedName?: string;
	parameterCount?: number;
	requiredParameterCount?: number;
	parameterTypes?: string[];
	returnType?: string;
	declaredType?: string;
	templateArguments?: string[];
	ownerId?: string;
	visibility?: string;
	isStatic?: boolean;
	isReadonly?: boolean;
	isAbstract?: boolean;
	isFinal?: boolean;
	annotations?: string[];
}

export interface ExtractedImport {
	filePath: string;
	rawImportPath: string;
	language: SupportedLanguages;
	/** Named bindings from the import (e.g., import {User as U} → [{local:'U', exported:'User'}]) */
	namedBindings?: NamedBinding[];
}

export interface ExtractedCall {
	filePath: string;
	calledName: string;
	/** generateId of enclosing function, or generateId('File', filePath) for top-level */
	sourceId: string;
	/** From call AST; omitted for some seeds (e.g. Java `::`) so arity filter is skipped */
	argCount?: number;
	/** Discriminates free function calls from member/constructor calls */
	callForm?: "free" | "member" | "constructor";
	/** Simple identifier of the receiver for member calls (e.g., 'user' in user.save()) */
	receiverName?: string;
	/** Resolved type name of the receiver (e.g., 'User' for user.save() when user: User) */
	receiverTypeName?: string;
	/**
	 * Unified mixed chain when the receiver is a chain of field accesses and/or method calls.
	 * Steps are ordered base-first (innermost to outermost). Examples:
	 *   `svc.getUser().save()`        → chain=[{kind:'call',name:'getUser'}], receiverName='svc'
	 *   `user.address.save()`         → chain=[{kind:'field',name:'address'}], receiverName='user'
	 *   `svc.getUser().address.save()` → chain=[{kind:'call',name:'getUser'},{kind:'field',name:'address'}]
	 * Length is capped at MAX_CHAIN_DEPTH (3).
	 */
	receiverMixedChain?: MixedChainStep[];
	argTypes?: (string | undefined)[];
}

export interface ExtractedAssignment {
	filePath: string;
	/** generateId of enclosing function, or generateId('File', filePath) for top-level */
	sourceId: string;
	/** Receiver text (e.g., 'user' from user.address = value) */
	receiverText: string;
	/** Property name being written (e.g., 'address') */
	propertyName: string;
	/** Resolved type name of the receiver if available from TypeEnv */
	receiverTypeName?: string;
	/** 1-indexed line number of the assignment site (used for per-site dedup) */
	line?: number;
}

// `ExtractedHeritage` now lives in `../model/heritage-map.ts` and is
// re-exported at the top of this file.

export interface ExtractedRoute {
	filePath: string;
	httpMethod: string;
	routePath: string | null;
	controllerName: string | null;
	methodName: string | null;
	middleware: string[];
	prefix: string | null;
	lineNumber: number;
}

export interface ExtractedFetchCall {
	filePath: string;
	fetchURL: string;
	lineNumber: number;
}

export interface ExtractedDecoratorRoute {
	filePath: string;
	routePath: string;
	httpMethod: string;
	decoratorName: string;
	lineNumber: number;
}

export interface ExtractedToolDef {
	filePath: string;
	toolName: string;
	description: string;
	lineNumber: number;
	handlerNodeId?: string;
}

export interface ExtractedORMQuery {
	filePath: string;
	orm: "prisma" | "supabase";
	model: string;
	method: string;
	lineNumber: number;
}

/** Constructor bindings keyed by filePath for cross-file type resolution */
export interface FileConstructorBindings {
	filePath: string;
	bindings: ConstructorBinding[];
}

/** All-scope type bindings from TypeEnv — includes function-local scopes.
 *  Used by BindingAccumulator for cross-file type propagation (Phase 9+).
 *
 *  Carries only file-scope entries (`scope = ''`). Serializing function-scope
 *  bindings over IPC cost ~4.9 MB with zero downstream consumers.
 *  `parse-worker.ts` now iterates only `typeEnv.fileScope()` and the
 *  sequential path's `type-env.ts::flush()` is also narrowed to file
 *  scope — see the `BindingAccumulator` class JSDoc for the unified
 *  narrowing contract across both execution paths.
 *
 *  **Phase 9 reversion checklist** (when a downstream consumer of
 *  function-scope bindings lands):
 *    1. Change the loop in `runParseJob` below from `typeEnv.fileScope()`
 *       back to `typeEnv.allScopes()`.
 *    2. Emit three-element tuples `[scope, varName, typeName]`.
 *    3. Widen the `bindings` field on this interface back to
 *       `[string, string, string][]`.
 *    4. Update the pipeline adapter in `pipeline.ts` to unpack three
 *       elements and populate `BindingEntry.scope` from the first tuple
 *       element instead of hardcoding `''`.
 *    5. Also revert `type-env.ts::flush()` to iterate `env` instead of
 *       just `FILE_SCOPE` if the sequential path needs function-scope data too.
 *    6. Consider renaming this interface back to `FileAllScopeBindings`
 *       along with widening. */
export interface FileScopeBindings {
	filePath: string;
	/** [varName, typeName] pairs from the file scope only. */
	bindings: [string, string][];
}

export interface ParseWorkerResult {
	nodes: ParsedNode[];
	relationships: ParsedRelationship[];
	symbols: ParsedSymbol[];
	imports: ExtractedImport[];
	calls: ExtractedCall[];
	assignments: ExtractedAssignment[];
	heritage: ExtractedHeritage[];
	routes: ExtractedRoute[];
	fetchCalls: ExtractedFetchCall[];
	decoratorRoutes: ExtractedDecoratorRoute[];
	toolDefs: ExtractedToolDef[];
	ormQueries: ExtractedORMQuery[];
	constructorBindings: FileConstructorBindings[];
	/** All-scope type bindings from TypeEnv for BindingAccumulator (includes function-local). */
	fileScopeBindings: FileScopeBindings[];
	/**
	 * Per-file `ParsedFile` artifacts from the new scope-based resolution
	 * pipeline (RFC #909 Ring 2). Empty unless the file's provider implements
	 * `emitScopeCaptures` — default for every language today, so this is
	 * additive and leaves the legacy DAG untouched. Consumed by #921's
	 * finalize-orchestrator.
	 */
	parsedFiles: ParsedFile[];
	skippedLanguages: Record<string, number>;
	fileCount: number;
}

export interface ParseWorkerInput {
	path: string;
	content: string;
}

export type WorkerIncomingMessage =
	| { type: "sub-batch"; files: ParseWorkerInput[] }
	| { type: "flush" }
	| ParseWorkerInput[];

