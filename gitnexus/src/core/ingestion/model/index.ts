/**
 * Semantic Model — public module surface.
 *
 * Barrel re-export for the `model/` module. Consumers outside `model/`
 * should import from this file rather than reaching into individual
 * registry files.
 *
 * The model is owner-scoped type/method/field knowledge layered above
 * `SymbolTable`. File-indexed and name-keyed callable lookups stay in
 * `SymbolTable` by design.
 */

// Unified semantic model (factory + interfaces). SemanticModel is the
// top-level container and owns the file/callable SymbolTable as a
// nested `symbols` field.
export {
	createSemanticModel,
	type MutableSemanticModel,
	type SemanticModel,
} from "./semantic-model.js";

// SymbolTable is exclusively owned by SemanticModel. Re-exported here
// for the rare caller that needs the file/callable interface in
// isolation (e.g. tests).
export {
	type AddMetadata,
	CALL_TARGET_TYPES,
	CLASS_TYPES,
	CLASS_TYPES_TUPLE,
	type ClassLikeLabel,
	createSymbolTable,
	FREE_CALLABLE_TUPLE,
	FREE_CALLABLE_TYPES,
	type FreeCallableLabel,
	type SymbolTableReader,
	type SymbolTableWriter,
} from "./symbol-table.js";

// `SymbolDefinition` moved to `gitnexus-shared` (RFC #909 Ring 1 #910).
// Consumers should import it directly from `gitnexus-shared`, not via this barrel.

// Field registry (owner-scoped fields/properties)
export {
	createFieldRegistry,
	type FieldRegistry,
	type MutableFieldRegistry,
} from "./field-registry.js";
// Heritage types and builder. `buildHeritageMap` + `resolveExtendsType` are
// exported directly from `heritage-map.ts` and are not re-surfaced here to
// keep the barrel narrow.
export type {
	ExtractedHeritage,
	HeritageMap,
	HeritageResolutionStrategy,
	HeritageStrategyLookup,
} from "./heritage-map.js";
// Method registry (owner-scoped methods with arity-aware overload lookup)
export {
	createMethodRegistry,
	type MethodRegistry,
	type MutableMethodRegistry,
} from "./method-registry.js";
// Behavior-grouped dispatch table for SymbolTable.add() routing.
// See registration-table.ts module JSDoc for the behavior group taxonomy
// and "how to add a new NodeLabel" checklist.
// NOTE: createRegistrationTable, RegistrationHook, and RegistrationTableDeps
// are deliberately NOT re-exported here — they are factory internals of
// SemanticModel and should only be imported directly from registration-table.js
// by semantic-model.ts and the registration-table.test.ts file.
export {
	ALL_NODE_LABELS,
	CALLABLE_ONLY_LABELS,
	DISPATCH_LABELS,
	INERT_LABELS,
	type LabelBehavior,
} from "./registration-table.js";

// Named-import types and package-dir helper. Re-exported so barrel
// consumers don't need to reach into a specific model file.
export {
	isFileInPackageDir,
	type NamedImportBinding,
	type NamedImportMap,
} from "./resolution-context.js";
// MRO-aware method resolution (C3, first-wins, leftmost-base, implements-split,
// qualified-syntax). Pure function that depends only on the model + HeritageMap.
// `MroStrategy` itself lives in `gitnexus-shared`; re-exported here for
// consumers that reach model behavior through the barrel.
export { lookupMethodByOwnerWithMRO } from "./resolve.js";
// Type registry (classes, structs, interfaces, enums, records, impls)
export {
	createTypeRegistry,
	type MutableTypeRegistry,
	type TypeRegistry,
} from "./type-registry.js";
