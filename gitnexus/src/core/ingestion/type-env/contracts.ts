import type { NodeLabel } from "gitnexus-shared";
import type { BindingAccumulator } from "../binding-accumulator.js";
import type { SemanticModel } from "../model/index.js";
import type { SyntaxNode } from "../utils/ast-helpers.js";

/**
 * Per-file scoped type environment: maps (scope, variableName) → typeName.
 * Scope-aware: variables inside functions are keyed by function name,
 * file-level variables use the '' (empty string) scope.
 *
 * Design constraints:
 * - Explicit-only: Tier 0 uses type annotations; Tier 1 infers from constructors
 * - Tier 2: single-pass assignment chain propagation in source order — resolves
 *   `const b = a` when `a` already has a type from Tier 0/1
 * - Scope-aware: function-local variables don't collide across functions
 * - Conservative: complex/generic types extract the base name only
 * - Per-file: built once, used for receiver resolution, then discarded
 */
export type TypeEnv = Map<string, Map<string, string>>;

/** File-level scope key */
export const FILE_SCOPE = "";

/** Shared empty map for files with no file-scope bindings. */
/**
 * Create a fresh empty Map for the "no file-scope bindings" fallback.
 *
 * **Why not a shared sentinel**: we previously used a module-level
 * `const EMPTY_FILE_SCOPE = new Map()` typed as `ReadonlyMap` and shared
 * across every TypeEnv instance. That was a latent singleton-poisoning
 * footgun: any caller that did `(fileScope() as Map).set(...)` — or any
 * future refactor that widened the return type — would silently corrupt
 * every subsequent "empty" return for the process lifetime. A Proxy
 * wrapper was considered but broke Map's internal-slot methods (`.size`,
 * iteration protocol). Allocating a fresh empty Map per call is a few
 * bytes per file — immediately GC'd, no measurable cost even at 10k files
 * — and eliminates the shared-mutation hazard entirely.
 */
export const emptyFileScope = (): ReadonlyMap<string, string> => new Map();
/**
 * Per-file type environment with receiver resolution.
 * Built once per file via `buildTypeEnv`, used for receiver-type filtering,
 * then discarded. Encapsulates scope-aware type lookup and self/this/super
 * AST resolution behind a single `.lookup()` method.
 */
export interface TypeEnvironment {
	/** Look up a variable's resolved type, with self/this/super AST resolution. */
	lookup(varName: string, callNode: SyntaxNode): string | undefined;
	/** Unverified cross-file constructor bindings for SymbolTable verification. */
	readonly constructorBindings: readonly ConstructorBinding[];
	/** Get all file-scope bindings (scope key = '') as a read-only map. */
	fileScope(): ReadonlyMap<string, string>;
	/** All scoped bindings as a read-only nested map (scope → varName → type).
	 *  Use for diagnostics/testing. Prefer lookup() for production call resolution. */
	allScopes(): ReadonlyMap<string, ReadonlyMap<string, string>>;
	/** Maps `scope\0varName` → constructor type for virtual dispatch override.
	 *  Populated when a variable has BOTH a declared base type AND a more specific
	 *  constructor type (e.g., `Animal a = new Dog()` → key maps to 'Dog'). */
	readonly constructorTypeMap: ReadonlyMap<string, string>;
	/** Copy all scoped bindings into a BindingAccumulator.
	 *  Must be called at most once per TypeEnv instance — throws on second call.
	 *  The source `env` is not cleared (TypeEnv is per-file and discarded immediately after). */
	flush(filePath: string, accumulator: BindingAccumulator): void;
}

/**
 * Position-indexed pattern binding: active only within a specific AST range.
 * Used for smart-cast narrowing in mutually exclusive branches (e.g., Kotlin when arms).
 */
export interface PatternOverride {
	rangeStart: number;
	rangeEnd: number;
	typeName: string;
}

/** scope → varName → overrides (checked in order, first range match wins) */
export type PatternOverrides = Map<string, Map<string, PatternOverride[]>>;
/**
 * Options for buildTypeEnv.
 * Uses an options object to allow future extensions without positional parameter sprawl.
 */
export interface BuildTypeEnvOptions {
	model?: SemanticModel;
	parentMap?: ReadonlyMap<string, readonly string[]>;
	/** Pre-resolved bindings from upstream files (Phase 14).
	 *  Seeded into FILE_SCOPE after walk() for names with no local binding.
	 *  Local declarations always take precedence (first-writer-wins). */
	importedBindings?: ReadonlyMap<string, string>;
	/** Cross-file return type fallback for imported callables (Phase 14 E3).
	 *  Consulted ONLY when SymbolTable has no unambiguous match.
	 *  Local definitions always take precedence (local-first principle). */
	importedReturnTypes?: ReadonlyMap<string, string>;
	/** Cross-file RAW return types for imported callables (Phase 14 E3).
	 *  Stores raw declared return type strings (e.g., 'User[]', 'List<User>').
	 *  Used by lookupRawReturnType for for-loop element extraction. */
	importedRawReturnTypes?: ReadonlyMap<string, string>;
	/** Language-specific enclosing function resolver for scope key lookup.
	 *  Same hook as LanguageProvider.enclosingFunctionFinder — handles languages
	 *  where function_body is a sibling of the signature (e.g., Dart). */
	enclosingFunctionFinder?: (
		ancestorNode: SyntaxNode,
	) => { funcName: string; label: NodeLabel } | null;
	/** Language-specific function name extraction from an AST node.
	 *  Replaces the generic name-field lookup for languages with non-standard
	 *  AST structures (C/C++ declarator unwrapping, Swift init/deinit, etc.).
	 *  When null is returned or not provided, falls back to node.childForFieldName('name')?.text. */
	extractFunctionName?: (
		node: SyntaxNode,
	) => { funcName: string | null; label: NodeLabel } | null;
}
/**
 * Unverified constructor binding: a `val x = Callee()` pattern where we
 * couldn't confirm the callee is a class (because it's defined in another file).
 * The caller must verify `calleeName` against the SymbolTable before trusting.
 */
export interface ConstructorBinding {
	/** Function scope key (matches TypeEnv scope keys) */
	scope: string;
	/** Variable name that received the constructor result */
	varName: string;
	/** Name of the callee (potential class constructor) */
	calleeName: string;
	/** Enclosing class name when callee is a method on a known receiver (e.g. $this) */
	receiverClassName?: string;
}
