import type { Capture, CaptureMatch } from "gitnexus-shared";
import { parseSourceSafe } from "../../../../tree-sitter/safe-parse.js";
import { getTreeSitterBufferSize } from "../../../constants.js";
import {
	findNodeAtRange,
	nodeToCapture,
	syntheticCapture,
} from "../../../utils/ast-helpers.js";
import {
	markCppAdlSiteArgs,
	markCppAdlSiteNoAdl,
} from "../adl.js";
import {
	computeCppCallArity,
	computeCppDeclarationArity,
} from "../arity-metadata.js";
import {
	markCppAnonymousNamespaceRange,
	markFileLocal,
} from "../file-local-linkage.js";
import { splitCppInclude, splitCppUsingDecl } from "../import-decomposer.js";
import { markCppInlineNamespaceRange } from "../inline-namespaces.js";
import { getCppParser, getCppScopeQuery } from "../query.js";
import {
	inferCppCallAdlArgs,
	isInlineNamespace,
	isParenthesizedFunctionCall,
} from "./adl-inference.js";
import { inferCppCallArgTypes } from "./call-types.js";
import {
	hasStaticStorageClass,
	isInsideAnonymousNamespace,
} from "./declarations.js";
import {
	detectCppDependentBases,
	emitCppInheritanceCaptures,
} from "./inheritance.js";

export function emitCppScopeCaptures(
	sourceText: string,
	filePath: string,
	cachedTree?: unknown,
): readonly CaptureMatch[] {
	let tree = cachedTree as
		| ReturnType<ReturnType<typeof getCppParser>["parse"]>
		| undefined;
	if (tree === undefined) {
		tree = parseSourceSafe(getCppParser(), sourceText, undefined, {
			bufferSize: getTreeSitterBufferSize(sourceText),
		});
	}

	const rawMatches = getCppScopeQuery().matches(tree.rootNode);
	const out: CaptureMatch[] = [];

	// Track ranges where typedef-struct was captured as @declaration.struct
	// so we can suppress the duplicate @declaration.typedef match.
	const structTypedefRanges = new Set<string>();

	for (const m of rawMatches) {
		const grouped: Record<string, Capture> = {};
		for (const c of m.captures) {
			const tag = `@${c.name}`;
			if (tag.startsWith("@_")) continue;
			grouped[tag] = nodeToCapture(tag, c.node);
		}
		if (Object.keys(grouped).length === 0) continue;

		// ── Handle #include statements ──────────────────────────────────
		if (grouped["@import.statement"] !== undefined) {
			const anchor = grouped["@import.statement"]!;
			const includeNode = findNodeAtRange(
				tree.rootNode,
				anchor.range,
				"preproc_include",
			);
			if (includeNode !== null) {
				const split = splitCppInclude(includeNode);
				if (split !== null) {
					out.push(split);
					continue;
				}
			}
		}

		// ── Handle using declarations (using namespace / using name) ────
		if (grouped["@import.using-decl"] !== undefined) {
			const anchor = grouped["@import.using-decl"]!;
			const usingNode = findNodeAtRange(
				tree.rootNode,
				anchor.range,
				"using_declaration",
			);
			if (usingNode !== null) {
				const split = splitCppUsingDecl(usingNode);
				if (split !== null) {
					out.push(split);
					continue;
				}
			}
		}

		// ── Track typedef-struct ranges ─────────────────────────────────
		const structAnchor =
			grouped["@declaration.struct"] ?? grouped["@declaration.class"];
		if (structAnchor !== undefined) {
			const r = structAnchor.range;
			structTypedefRanges.add(
				`${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`,
			);
		}

		// Suppress @declaration.typedef if the same range was already captured
		const typedefAnchor = grouped["@declaration.typedef"];
		if (typedefAnchor !== undefined) {
			const r = typedefAnchor.range;
			const key = `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
			if (structTypedefRanges.has(key)) continue;
		}

		// ── Enrich function/method declarations with arity metadata ─────
		const declAnchor =
			grouped["@declaration.function"] ?? grouped["@declaration.method"];
		if (declAnchor !== undefined) {
			const fnNode =
				findNodeAtRange(tree.rootNode, declAnchor.range, "function_definition") ??
				findNodeAtRange(tree.rootNode, declAnchor.range, "declaration") ??
				findNodeAtRange(tree.rootNode, declAnchor.range, "field_declaration");
			if (fnNode !== null) {
				const arity = computeCppDeclarationArity(fnNode);
				if (arity.parameterCount !== undefined) {
					grouped["@declaration.parameter-count"] = syntheticCapture(
						"@declaration.parameter-count",
						fnNode,
						String(arity.parameterCount),
					);
				}
				if (arity.requiredParameterCount !== undefined) {
					grouped["@declaration.required-parameter-count"] = syntheticCapture(
						"@declaration.required-parameter-count",
						fnNode,
						String(arity.requiredParameterCount),
					);
				}
				if (arity.parameterTypes !== undefined) {
					grouped["@declaration.parameter-types"] = syntheticCapture(
						"@declaration.parameter-types",
						fnNode,
						JSON.stringify(arity.parameterTypes),
					);
				}

				// Detect static storage class (file-local linkage)
				if (hasStaticStorageClass(fnNode)) {
					const nameText = grouped["@declaration.name"]?.text;
					if (nameText !== undefined) {
						markFileLocal(filePath, nameText);
					}
				}

				// Detect anonymous namespace (file-local linkage)
				if (isInsideAnonymousNamespace(fnNode)) {
					const nameText = grouped["@declaration.name"]?.text;
					if (nameText !== undefined) {
						markFileLocal(filePath, nameText);
					}
				}
			}
		}

		// ── Detect static variables (file-local linkage) ────────────────
		const varDeclAnchor = grouped["@declaration.variable"];
		if (varDeclAnchor !== undefined) {
			const varNode = findNodeAtRange(
				tree.rootNode,
				varDeclAnchor.range,
				"declaration",
			);
			if (varNode !== null) {
				if (hasStaticStorageClass(varNode) || isInsideAnonymousNamespace(varNode)) {
					const nameText = grouped["@declaration.name"]?.text;
					if (nameText !== undefined) {
						markFileLocal(filePath, nameText);
					}
				}
			}
		}

		// ── Enrich call references with arity ───────────────────────────
		const callAnchor =
			grouped["@reference.call.free"] ??
			grouped["@reference.call.member"] ??
			grouped["@reference.call.qualified"];
		if (callAnchor !== undefined && grouped["@reference.arity"] === undefined) {
			const callNode = findNodeAtRange(
				tree.rootNode,
				callAnchor.range,
				"call_expression",
			);
			if (callNode !== null) {
				grouped["@reference.arity"] = syntheticCapture(
					"@reference.arity",
					callNode,
					String(computeCppCallArity(callNode)),
				);
			}
		}

		// ── Enrich constructor calls (new Foo()) with arity ─────────────
		const ctorCallAnchor = grouped["@reference.call.constructor"];
		if (
			ctorCallAnchor !== undefined &&
			grouped["@reference.arity"] === undefined
		) {
			const newNode = findNodeAtRange(
				tree.rootNode,
				ctorCallAnchor.range,
				"new_expression",
			);
			if (newNode !== null) {
				grouped["@reference.arity"] = syntheticCapture(
					"@reference.arity",
					newNode,
					String(computeCppCallArity(newNode)),
				);
			}
		}

		// ── Synthesize argument types for overload narrowing ────────────
		const anyCallAnchor = callAnchor ?? ctorCallAnchor;
		if (
			anyCallAnchor !== undefined &&
			grouped["@reference.parameter-types"] === undefined
		) {
			const cNode =
				findNodeAtRange(tree.rootNode, anyCallAnchor.range, "call_expression") ??
				findNodeAtRange(tree.rootNode, anyCallAnchor.range, "new_expression");
			if (cNode !== null) {
				const argTypes = inferCppCallArgTypes(cNode);
				if (argTypes !== undefined && argTypes.length > 0) {
					grouped["@reference.parameter-types"] = syntheticCapture(
						"@reference.parameter-types",
						cNode,
						JSON.stringify(argTypes),
					);
				}
			}
		}

		// ── Inline namespace detection ──────────────────────────────────
		// `inline namespace v1 { ... }` — tree-sitter-cpp exposes the
		// `inline` keyword as a child of `namespace_definition`. Record the
		// namespace's source range so `populateCppInlineNamespaceScopes`
		// (during populateOwners) can match it back to the corresponding
		// Namespace scope.
		// `@declaration.namespace` fires only for NAMED namespaces (the query
		// requires a `name: (namespace_identifier)` child). Use the unconditional
		// `@scope.namespace` capture so the anonymous-namespace branch also runs.
		const namespaceScopeAnchor =
			grouped["@declaration.namespace"] ?? grouped["@scope.namespace"];
		if (namespaceScopeAnchor !== undefined) {
			const nsNode = findNodeAtRange(
				tree.rootNode,
				namespaceScopeAnchor.range,
				"namespace_definition",
			);
			if (nsNode !== null) {
				// Range coords stored in the shared Range shape use 1-based
				// line numbers (see `ast-helpers.ts` rangeForNode where
				// `startPosition.row + 1` is applied). Match that convention so
				// the populators can join against `Scope.range`.
				const nsRange = {
					startLine: nsNode.startPosition.row + 1,
					startCol: nsNode.startPosition.column,
					endLine: nsNode.endPosition.row + 1,
					endCol: nsNode.endPosition.column,
				};
				if (isInlineNamespace(nsNode)) {
					markCppInlineNamespaceRange(filePath, nsRange);
				}
				// Anonymous namespace: `namespace_definition` with no `name` field.
				// Recorded so `expandCppWildcardNames` can propagate its members
				// to including TUs even though their names are also `markFileLocal`'d
				// (which blocks the global free-call fallback's cross-file path).
				if ((nsNode.childForFieldName?.("name") ?? null) === null) {
					markCppAnonymousNamespaceRange(filePath, nsRange);
				}
			}
		}

		// ── ADL (Koenig lookup) per-site recording ──────────────────────
		// Only free-call sites (no explicit receiver) participate in ADL —
		// qualified `Ns::f(s)` and member `obj.f(s)` calls bypass the
		// free-call fallback entirely (handled by receiver-bound-calls).
		if (grouped["@reference.call.free"] !== undefined) {
			const freeCallNode = findNodeAtRange(
				tree.rootNode,
				grouped["@reference.call.free"]?.range,
				"call_expression",
			);
			if (freeCallNode !== null) {
				const adlAnchorRange = grouped["@reference.call.free"]?.range;
				if (isParenthesizedFunctionCall(freeCallNode)) {
					markCppAdlSiteNoAdl(
						filePath,
						adlAnchorRange.startLine,
						adlAnchorRange.startCol,
					);
				}
				const adlArgs = inferCppCallAdlArgs(freeCallNode);
				if (adlArgs.length > 0) {
					markCppAdlSiteArgs(
						filePath,
						adlAnchorRange.startLine,
						adlAnchorRange.startCol,
						adlArgs,
					);
				}
			}
		}

		// ── Post-process @type-binding.assignment for auto declarations ──
		// The wildcard `type: (_)` in the @type-binding.assignment query
		// pattern matches before the more specific @type-binding.alias and
		// @type-binding.member-access patterns. When the type is `auto`
		// (placeholder_type_specifier), we re-inspect the AST to synthesize
		// the correct capture tags so interpret.ts can produce the right
		// rawTypeName for compound-receiver chain resolution.
		if (
			grouped["@type-binding.assignment"] !== undefined &&
			grouped["@type-binding.type"]?.text === "auto"
		) {
			const anchor = grouped["@type-binding.assignment"]!;
			const declNode = findNodeAtRange(tree.rootNode, anchor.range, "declaration");
			if (declNode !== null) {
				const declarator = declNode.childForFieldName("declarator");
				if (declarator?.type === "init_declarator") {
					const valueNode = declarator.childForFieldName("value");
					if (valueNode !== null) {
						if (valueNode.type === "identifier") {
							// auto alias = existingVar → promote to @type-binding.alias
							grouped["@type-binding.alias"] = anchor;
							grouped["@type-binding.type"] = nodeToCapture(
								"@type-binding.type",
								valueNode,
							);
							delete grouped["@type-binding.assignment"];
						} else if (valueNode.type === "field_expression") {
							// auto addr = user.address → promote to @type-binding.member-access
							const argNode = valueNode.childForFieldName("argument");
							const fieldNode = valueNode.childForFieldName("field");
							if (argNode !== null && fieldNode !== null) {
								grouped["@type-binding.member-access"] = anchor;
								grouped["@type-binding.member-access-receiver"] = nodeToCapture(
									"@type-binding.member-access-receiver",
									argNode,
								);
								grouped["@type-binding.type"] = nodeToCapture(
									"@type-binding.type",
									fieldNode,
								);
								delete grouped["@type-binding.assignment"];
							}
						} else if (valueNode.type === "call_expression") {
							const fnNode = valueNode.childForFieldName("function");
							if (fnNode?.type === "field_expression") {
								// auto city = addr.getCity() → promote to @type-binding.alias
								// with dotted rawName "addr.getCity" for compound-receiver
								const argNode = fnNode.childForFieldName("argument");
								const fieldNode = fnNode.childForFieldName("field");
								if (argNode !== null && fieldNode !== null) {
									grouped["@type-binding.member-access"] = anchor;
									grouped["@type-binding.member-access-receiver"] = nodeToCapture(
										"@type-binding.member-access-receiver",
										argNode,
									);
									grouped["@type-binding.type"] = nodeToCapture(
										"@type-binding.type",
										fieldNode,
									);
									delete grouped["@type-binding.assignment"];
								}
							}
						}
					}
				}
			}
		}

		out.push(grouped);
	}

	// ── Emit inheritance references for scope-resolution MRO / EXTENDS ──
	// Walk every class/struct base list and synthesize `@reference.inherits`
	// captures consumed by the registry-primary graph bridge. The lookup name
	// is normalized to the bare class name so `Base<T>` / `outer::v1::Base<T>`
	// resolve through V1's simple-name `findClassBindingInScope('Base')`.
	emitCppInheritanceCaptures(tree.rootNode, out);

	// ── Detect dependent-base relationships for two-phase template lookup ──
	// Walk the tree once, finding every `template_declaration` whose
	// child is a class/struct definition with a `base_class_clause` whose
	// base names reference an in-scope template parameter. Record the
	// (className, dependentBaseName) pair so `populateCppDependentBases`
	// (called from the `populateOwners` hook) can resolve names to nodeIds
	// and the resolver can suppress unqualified-call binding to those
	// bases per ISO C++ two-phase lookup.
	detectCppDependentBases(tree.rootNode, filePath);

	return out;
}
