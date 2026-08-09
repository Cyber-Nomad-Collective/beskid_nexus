import { createRequire } from "node:module";
import { SupportedLanguages } from "gitnexus-shared";
import Parser from "tree-sitter";
import C from "tree-sitter-c";
// Explicit subpath import — see parser-loader.ts for rationale (#1013).
import CSharp from "tree-sitter-c-sharp/bindings/node/index.js";
import CPP from "tree-sitter-cpp";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import JavaScript from "tree-sitter-javascript";
import PHP from "tree-sitter-php";
import Python from "tree-sitter-python";
import Ruby from "tree-sitter-ruby";
import Rust from "tree-sitter-rust";
import TypeScript from "tree-sitter-typescript";

/** Language grammar type accepted by Parser.setLanguage(). */
type TreeSitterLanguage = Parameters<typeof Parser.prototype.setLanguage>[0];

// tree-sitter-swift is an optionalDependency — may not be installed
const _require = createRequire(import.meta.url);
let Swift: TreeSitterLanguage | null = null;
try {
	Swift = _require("tree-sitter-swift");
} catch {}

// tree-sitter-dart is an optionalDependency — may not be installed
let Dart: TreeSitterLanguage | null = null;
try {
	Dart = _require("tree-sitter-dart");
} catch {}

// tree-sitter-kotlin is an optionalDependency — may not be installed
let Kotlin: TreeSitterLanguage | null = null;
try {
	Kotlin = _require("tree-sitter-kotlin");
} catch {}
// ============================================================================
// Worker-local parser + language map
// ============================================================================

export const parser = new Parser();

const languageMap: Record<string, TreeSitterLanguage> = {
	[SupportedLanguages.JavaScript]: JavaScript,
	[SupportedLanguages.TypeScript]: TypeScript.typescript,
	[`${SupportedLanguages.TypeScript}:tsx`]: TypeScript.tsx,
	[SupportedLanguages.Python]: Python,
	[SupportedLanguages.Java]: Java,
	[SupportedLanguages.C]: C,
	[SupportedLanguages.CPlusPlus]: CPP,
	[SupportedLanguages.CSharp]: CSharp,
	[SupportedLanguages.Go]: Go,
	[SupportedLanguages.Rust]: Rust,
	...(Kotlin ? { [SupportedLanguages.Kotlin]: Kotlin } : {}),
	[SupportedLanguages.PHP]: PHP.php_only,
	[SupportedLanguages.Ruby]: Ruby,
	[SupportedLanguages.Vue]: TypeScript.typescript,
	...(Dart ? { [SupportedLanguages.Dart]: Dart } : {}),
	...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
};

/**
 * Check if a language grammar is available in this worker.
 * Duplicated from parser-loader.ts because workers can't import from the main thread.
 * Extra filePath parameter needed to distinguish .tsx from .ts (different grammars
 * under the same SupportedLanguages.TypeScript key).
 */
export const isLanguageAvailable = (
	language: SupportedLanguages,
	filePath: string,
): boolean => {
	const key =
		language === SupportedLanguages.TypeScript && filePath.endsWith(".tsx")
			? `${language}:tsx`
			: language;
	return key in languageMap && languageMap[key] != null;
};

export const setLanguage = (language: SupportedLanguages, filePath: string): void => {
	const key =
		language === SupportedLanguages.TypeScript && filePath.endsWith(".tsx")
			? `${language}:tsx`
			: language;
	const lang = languageMap[key];
	if (!lang) throw new Error(`Unsupported language: ${language}`);
	parser.setLanguage(lang);
};

