import type { SupportedLanguages } from "gitnexus-shared";
import { generateId } from "../../../lib/utils.js";
import type { KnowledgeGraph } from "../../graph/types.js";
import { getProvider } from "../languages/index.js";
import { c3Linearize, gatherAncestors } from "../model/resolve.js";
import type {
	MethodAmbiguity,
	MethodDef,
	MROEntry,
	MROResult,
	Resolution,
} from "./contracts.js";
import { emitMethodImplementsEdges } from "./emission.js";
import { buildAdjacency } from "./graph-collection.js";
import {
	resolveByMroOrder,
	resolveCsharpJava,
} from "./language-rules.js";
import { buildTransitiveEdgeTypes } from "./member-resolution.js";

export function computeMRO(graph: KnowledgeGraph): MROResult {
	const { parentMap, methodMap, parentEdgeType } = buildAdjacency(graph);
	const c3Cache = new Map<string, string[] | null>();

	const entries: MROEntry[] = [];
	let overrideEdges = 0;
	let ambiguityCount = 0;

	// Pre-computed maps to avoid redundant BFS in emitMethodImplementsEdges
	const ancestorsMap = new Map<string, string[]>();
	const edgeTypesMap = new Map<string, Map<string, "EXTENDS" | "IMPLEMENTS">>();

	// Process every class that has at least one parent
	for (const [classId, directParents] of parentMap) {
		if (directParents.length === 0) continue;

		const classNode = graph.getNode(classId);
		if (!classNode) continue;

		const language = classNode.properties.language as
			| SupportedLanguages
			| undefined;
		if (!language) continue;
		const className = classNode.properties.name;

		// Compute linearized MRO depending on language strategy
		const provider = getProvider(language);
		const ancestors = gatherAncestors(classId, parentMap);
		ancestorsMap.set(classId, ancestors);
		edgeTypesMap.set(
			classId,
			buildTransitiveEdgeTypes(classId, parentMap, parentEdgeType),
		);

		let mroOrder: string[];
		if (provider.mroStrategy === "c3") {
			const c3Result = c3Linearize(classId, parentMap, c3Cache);
			mroOrder = c3Result ?? ancestors;
		} else {
			mroOrder = ancestors;
		}

		// Get the parent names for the MRO entry
		const mroNames: string[] = mroOrder
			.map((id) => graph.getNode(id)?.properties.name)
			.filter((n): n is string => n !== undefined);

		// Collect methods from all ancestors, grouped by method name
		const methodsByName = new Map<string, MethodDef[]>();
		for (const ancestorId of mroOrder) {
			const ancestorNode = graph.getNode(ancestorId);
			if (!ancestorNode) continue;

			const methods = methodMap.get(ancestorId) ?? [];
			for (const methodId of methods) {
				const methodNode = graph.getNode(methodId);
				if (!methodNode) continue;
				// Properties don't participate in method resolution order
				if (methodNode.label === "Property") continue;

				const methodName = methodNode.properties.name;
				let defs = methodsByName.get(methodName);
				if (!defs) {
					defs = [];
					methodsByName.set(methodName, defs);
				}
				// Avoid duplicates (same method seen via multiple paths)
				if (!defs.some((d) => d.methodId === methodId)) {
					defs.push({
						classId: ancestorId,
						className: ancestorNode.properties.name,
						methodId,
					});
				}
			}
		}

		// Detect collisions: methods defined in 2+ different ancestors
		const ambiguities: MethodAmbiguity[] = [];

		// Use pre-computed transitive edge types (only needed for implements-split languages)
		const needsEdgeTypes = provider.mroStrategy === "implements-split";
		const classEdgeTypes = needsEdgeTypes ? edgeTypesMap.get(classId) : undefined;

		for (const [methodName, defs] of methodsByName) {
			if (defs.length < 2) continue;

			// Own method shadows inherited — no ambiguity
			const ownMethods = methodMap.get(classId) ?? [];
			const ownDefinesIt = ownMethods.some((mid) => {
				const mn = graph.getNode(mid);
				return mn?.properties.name === methodName;
			});
			if (ownDefinesIt) continue;

			let resolution: Resolution;

			switch (provider.mroStrategy) {
				case "leftmost-base":
					resolution = resolveByMroOrder(
						methodName,
						defs,
						mroOrder,
						"leftmost base",
					);
					break;
				case "implements-split":
					resolution = resolveCsharpJava(methodName, defs, classEdgeTypes);
					break;
				case "c3":
					resolution = resolveByMroOrder(methodName, defs, mroOrder, "C3 MRO");
					break;
				case "qualified-syntax":
					resolution = {
						resolvedTo: null,
						reason: `requires qualified syntax: <Type as Trait>::${methodName}()`,
						confidence: 0.5,
					};
					break;
				default:
					resolution = resolveByMroOrder(
						methodName,
						defs,
						mroOrder,
						"first definition",
					);
					break;
			}

			const ambiguity: MethodAmbiguity = {
				methodName,
				definedIn: defs,
				resolvedTo: resolution.resolvedTo,
				reason: resolution.reason,
			};
			ambiguities.push(ambiguity);

			if (resolution.resolvedTo === null) {
				ambiguityCount++;
			}

			// Emit METHOD_OVERRIDES edge if resolution found
			if (resolution.resolvedTo !== null) {
				graph.addRelationship({
					id: generateId("METHOD_OVERRIDES", `${classId}->${resolution.resolvedTo}`),
					sourceId: classId,
					targetId: resolution.resolvedTo,
					type: "METHOD_OVERRIDES",
					confidence: resolution.confidence,
					reason: resolution.reason,
				});
				overrideEdges++;
			}
		}

		entries.push({
			classId,
			className,
			language,
			mro: mroNames,
			ambiguities,
		});
	}

	const methodImplementsEdges = emitMethodImplementsEdges(
		graph,
		parentMap,
		methodMap,
		parentEdgeType,
		ancestorsMap,
		edgeTypesMap,
	);

	return { entries, overrideEdges, ambiguityCount, methodImplementsEdges };
}
