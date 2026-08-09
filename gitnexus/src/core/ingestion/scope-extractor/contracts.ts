import type {
	BindingRef,
	CaptureMatch,
	ImportEdge,
	Range,
	ScopeId,
	ScopeKind,
	SymbolDefinition,
	TypeRef,
} from "gitnexus-shared";
import type { LanguageProvider } from "../language-provider.js";

export type ScopeExtractorHooks = Pick<
	LanguageProvider,
	| "resolveScopeKind"
	| "bindingScopeFor"
	| "interpretImport"
	| "interpretTypeBinding"
	| "classifyCallForm"
>;

export interface Partitioned {
	readonly scope: readonly CaptureMatch[];
	readonly declaration: readonly CaptureMatch[];
	readonly import_: readonly CaptureMatch[];
	readonly typeBinding: readonly CaptureMatch[];
	readonly reference: readonly CaptureMatch[];
}

export type Topic =
	| "scope"
	| "declaration"
	| "import"
	| "type-binding"
	| "reference"
	| "unknown";

export interface ScopeDraft {
	readonly id: ScopeId;
	readonly parent: ScopeId | null;
	readonly kind: ScopeKind;
	readonly range: Range;
	readonly filePath: string;
	readonly bindings: Map<string, BindingRef[]>;
	readonly ownedDefs: SymbolDefinition[];
	readonly imports: ImportEdge[];
	readonly typeBindings: Map<string, TypeRef>;
}
