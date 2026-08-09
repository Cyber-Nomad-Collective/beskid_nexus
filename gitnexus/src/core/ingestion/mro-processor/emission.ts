import { generateId } from "../../../lib/utils.js";
import type { KnowledgeGraph } from "../../graph/types.js";
import { gatherAncestors } from "../model/resolve.js";
import {
	buildTransitiveEdgeTypes,
	findInheritedMethod,
	parameterTypesMatch,
} from "./member-resolution.js";

/**
 * For each concrete class that implements/extends an interface or trait,
 * find methods in the class that implement methods defined in the interface
 * and emit METHOD_IMPLEMENTS edges: ConcreteMethod → InterfaceMethod.
 *
 * Method node IDs include a `#<paramCount>` arity suffix, so overloaded
 * methods with different parameter counts are distinct nodes in the graph.
 * For same-arity overloads with different parameter types, a `~type1,type2`
 * suffix is appended when type info is available (issue #651), producing
 * distinct nodes that `parameterTypesMatch` can resolve to correct edges.
 */
export function emitMethodImplementsEdges(
	graph: KnowledgeGraph,
	parentMap: Map<string, string[]>,
	methodMap: Map<string, string[]>,
	parentEdgeType: Map<string, Map<string, "EXTENDS" | "IMPLEMENTS">>,
	ancestorsMap: Map<string, string[]>,
	edgeTypesMap: Map<string, Map<string, "EXTENDS" | "IMPLEMENTS">>,
): number {
	let edgeCount = 0;

	for (const [classId, _parentIds] of parentMap) {
		const classNode = graph.getNode(classId);
		if (!classNode) continue;

		// Interfaces and traits declare contracts — they don't implement them
		if (classNode.label === "Interface" || classNode.label === "Trait") continue;

		// Get this class's own methods
		const ownMethodIds = methodMap.get(classId) ?? [];

		// Build a lookup: methodName → Array<{methodId, parameterTypes, parameterCount}> for own methods
		const ownMethodsByName = new Map<
			string,
			Array<{
				methodId: string;
				parameterTypes: string[];
				parameterCount?: number;
			}>
		>();
		for (const methodId of ownMethodIds) {
			const methodNode = graph.getNode(methodId);
			if (!methodNode || methodNode.label === "Property") continue;
			// Abstract methods don't satisfy interface contracts
			if (methodNode.properties.isAbstract === true) continue;
			const name = methodNode.properties.name as string;
			const parameterTypes =
				(methodNode.properties.parameterTypes as string[] | undefined) ?? [];
			const parameterCount = methodNode.properties.parameterCount as
				| number
				| undefined;
			let bucket = ownMethodsByName.get(name);
			if (!bucket) {
				bucket = [];
				ownMethodsByName.set(name, bucket);
			}
			bucket.push({ methodId, parameterTypes, parameterCount });
		}

		// Use pre-computed ancestors and edge types; fall back to computing if missing (safety)
		const allAncestors =
			ancestorsMap.get(classId) ?? gatherAncestors(classId, parentMap);
		const ancestorEdgeTypes =
			edgeTypesMap.get(classId) ??
			buildTransitiveEdgeTypes(classId, parentMap, parentEdgeType);

		// Dedup set: avoid duplicate edges from diamond paths
		const emitted = new Set<string>();

		// For each ancestor, check if it's an interface/trait or classified as IMPLEMENTS
		for (const ancestorId of allAncestors) {
			const ancestorNode = graph.getNode(ancestorId);
			if (!ancestorNode) continue;

			const isInterfaceLike =
				ancestorNode.label === "Interface" || ancestorNode.label === "Trait";
			const classifiedEdgeType = ancestorEdgeTypes.get(ancestorId);
			if (!isInterfaceLike && classifiedEdgeType !== "IMPLEMENTS") continue;

			// Get ancestor's methods
			const ancestorMethodIds = methodMap.get(ancestorId) ?? [];

			for (const ancestorMethodId of ancestorMethodIds) {
				const ancestorMethodNode = graph.getNode(ancestorMethodId);
				if (!ancestorMethodNode || ancestorMethodNode.label === "Property")
					continue;

				const ancestorName = ancestorMethodNode.properties.name as string;
				const ancestorParamTypes =
					(ancestorMethodNode.properties.parameterTypes as string[] | undefined) ??
					[];
				const ancestorParamCount = ancestorMethodNode.properties.parameterCount as
					| number
					| undefined;

				// Find matching method in own class by name + parameterTypes/arity
				const candidates = ownMethodsByName.get(ancestorName);

				// Unit 3: If no own method matches, walk the EXTENDS chain to find inherited concrete method
				if (!candidates || candidates.length === 0) {
					const inherited = findInheritedMethod(
						classId,
						ancestorName,
						ancestorParamTypes,
						ancestorParamCount,
						graph,
						parentMap,
						methodMap,
						parentEdgeType,
						ancestorMethodId,
					);
					if (inherited) {
						const edgeKey = `${inherited.methodId}->${ancestorMethodId}`;
						if (!emitted.has(edgeKey)) {
							emitted.add(edgeKey);
							graph.addRelationship({
								id: generateId("METHOD_IMPLEMENTS", edgeKey),
								sourceId: inherited.methodId,
								targetId: ancestorMethodId,
								type: "METHOD_IMPLEMENTS",
								confidence: inherited.confident ? 1.0 : 0.7,
								reason: "",
							});
							edgeCount++;
						}
					}
					continue;
				}

				// Unit 4: Filter candidates by type/arity match, then check for ambiguity
				const matching: Array<{
					methodId: string;
					parameterTypes: string[];
					parameterCount?: number;
					confident: boolean;
				}> = [];
				for (const c of candidates) {
					const result = parameterTypesMatch(
						c.parameterTypes,
						ancestorParamTypes,
						c.parameterCount,
						ancestorParamCount,
					);
					if (result.match) {
						matching.push({ ...c, confident: result.confident });
					}
				}

				if (matching.length === 0) continue;

				// If multiple candidates match at name+arity level, emit no edge (ambiguous)
				if (matching.length > 1) continue;

				const winner = matching[0];
				const edgeKey = `${winner.methodId}->${ancestorMethodId}`;
				if (emitted.has(edgeKey)) continue;
				emitted.add(edgeKey);

				graph.addRelationship({
					id: generateId("METHOD_IMPLEMENTS", edgeKey),
					sourceId: winner.methodId,
					targetId: ancestorMethodId,
					type: "METHOD_IMPLEMENTS",
					confidence: winner.confident ? 1.0 : 0.7,
					reason: "",
				});
				edgeCount++;
			}
		}
	}

	return edgeCount;
}
