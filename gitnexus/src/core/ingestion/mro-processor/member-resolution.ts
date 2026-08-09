import type { KnowledgeGraph } from "../../graph/types.js";

/**
 * Check if two parameter type arrays match.
 * When either side has no type info, fall back to parameterCount comparison
 * (arity-compatible matching). If both have parameterCount and they differ,
 * return no match. If counts match, return confident match. If either count
 * is undefined, return lenient (non-confident) match.
 *
 * Returns `{ match, confident }`:
 * - Exact type match → `{ match: true, confident: true }`
 * - Arity match (both have parameterCount, counts equal) → `{ match: true, confident: true }`
 * - Lenient (either side lacks types AND lacks parameterCount) → `{ match: true, confident: false }`
 * - No match → `{ match: false, confident: false }`
 */
export function parameterTypesMatch(
	a: string[],
	b: string[],
	aParamCount?: number,
	bParamCount?: number,
): { match: boolean; confident: boolean } {
	// If one side is variadic and the other isn't, types may match superficially
	// but the methods aren't guaranteed to be interchangeable
	if ((aParamCount === undefined) !== (bParamCount === undefined)) {
		return { match: true, confident: false };
	}

	if (a.length === 0 || b.length === 0) {
		// Fall back to arity check when type info is missing
		if (aParamCount !== undefined && bParamCount !== undefined) {
			return {
				match: aParamCount === bParamCount,
				confident: aParamCount === bParamCount,
			};
		}
		return { match: true, confident: false }; // lenient when either count is unknown
	}
	if (a.length !== b.length) return { match: false, confident: false };
	const exact = a.every((t, i) => t === b[i]);
	return { match: exact, confident: exact };
}

/**
 * Walk the class's EXTENDS chain to find the nearest concrete method matching
 * the given name and parameter signature. If the EXTENDS chain yields no match,
 * fall back to IMPLEMENTS parents and check for non-abstract default methods
 * (e.g. Java default interface methods, Kotlin interface defaults).
 * Returns the first matching method found in BFS order, or null.
 */
export function findInheritedMethod(
	classId: string,
	methodName: string,
	targetParamTypes: string[],
	targetParamCount: number | undefined,
	graph: KnowledgeGraph,
	parentMap: Map<string, string[]>,
	methodMap: Map<string, string[]>,
	parentEdgeType: Map<string, Map<string, "EXTENDS" | "IMPLEMENTS">>,
	/** Method ID to exclude from results (prevents self-edges when the ancestor
	 *  method being matched lives on an IMPLEMENTS parent). */
	excludeMethodId?: string,
): { methodId: string; parameterTypes: string[]; confident: boolean } | null {
	const visited = new Set<string>();
	const queue: string[] = [];

	// Seed with direct EXTENDS parents only
	const directParents = parentMap.get(classId) ?? [];
	const directEdges = parentEdgeType.get(classId);
	for (const pid of directParents) {
		const et = directEdges?.get(pid);
		if (et === "EXTENDS") {
			// Also check that the parent is not an Interface/Trait
			const parentNode = graph.getNode(pid);
			if (
				parentNode &&
				parentNode.label !== "Interface" &&
				parentNode.label !== "Trait"
			) {
				queue.push(pid);
			}
		}
	}

	// Level-order BFS: process all ancestors at the current depth before
	// advancing. Once any match is found at depth D, finish that depth and stop.
	// Diamond dedup: same methodId via two paths at the same depth = 1 match.
	let currentLevel = [...queue];

	while (currentLevel.length > 0) {
		const matches = new Map<
			string,
			{ methodId: string; parameterTypes: string[]; confident: boolean }
		>();
		const nextLevel: string[] = [];

		for (const ancestorId of currentLevel) {
			if (visited.has(ancestorId)) continue;
			visited.add(ancestorId);

			// Check this ancestor's methods
			const methods = methodMap.get(ancestorId) ?? [];
			for (const mid of methods) {
				const mNode = graph.getNode(mid);
				if (!mNode || mNode.label === "Property") continue;
				// Abstract inherited methods don't count as concrete implementations
				if (mNode.properties.isAbstract === true) continue;
				if (mNode.properties.name !== methodName) continue;

				const mParamTypes =
					(mNode.properties.parameterTypes as string[] | undefined) ?? [];
				const mParamCount = mNode.properties.parameterCount as number | undefined;
				const ptResult = parameterTypesMatch(
					mParamTypes,
					targetParamTypes,
					mParamCount,
					targetParamCount,
				);
				if (ptResult.match) {
					matches.set(mid, {
						methodId: mid,
						parameterTypes: mParamTypes,
						confident: ptResult.confident,
					});
				}
			}

			// Collect EXTENDS parents for the next depth level
			const grandparents = parentMap.get(ancestorId) ?? [];
			const ancestorEdges = parentEdgeType.get(ancestorId);
			for (const gp of grandparents) {
				if (visited.has(gp)) continue;
				const gpEdge = ancestorEdges?.get(gp);
				if (gpEdge === "EXTENDS") {
					const gpNode = graph.getNode(gp);
					if (gpNode && gpNode.label !== "Interface" && gpNode.label !== "Trait") {
						nextLevel.push(gp);
					}
				}
			}
		}

		// If any matches found at this depth, decide and stop
		if (matches.size === 1) return matches.values().next().value!;
		if (matches.size > 1) return null; // ambiguous at same depth

		currentLevel = nextLevel;
	}

	// ── Second pass: walk IMPLEMENTS parents AND their interface ancestry ──
	// Only reached when the EXTENDS chain yielded no match.
	// BFS through interface/trait hierarchy to find default (non-abstract) methods.
	const implBfsQueue: string[] = [];
	for (const pid of directParents) {
		const et = directEdges?.get(pid);
		if (et === "IMPLEMENTS") {
			implBfsQueue.push(pid);
		}
	}

	// Collect all matches from the IMPLEMENTS BFS — return null if ambiguous (>1 match)
	const implMatches: Array<{
		methodId: string;
		parameterTypes: string[];
		confident: boolean;
	}> = [];
	const implVisited = new Set<string>();
	while (implBfsQueue.length > 0) {
		const ifaceId = implBfsQueue.shift()!;
		if (implVisited.has(ifaceId)) continue;
		implVisited.add(ifaceId);

		// Only process Interface/Trait nodes — Dart `implements Class` does not
		// inherit method bodies, so Class/Struct/Enum parents must be skipped.
		const ifaceNode = graph.getNode(ifaceId);
		if (
			!ifaceNode ||
			(ifaceNode.label !== "Interface" && ifaceNode.label !== "Trait")
		)
			continue;

		// Check this interface/trait's methods for a non-abstract default
		const methods = methodMap.get(ifaceId) ?? [];
		for (const mid of methods) {
			if (mid === excludeMethodId) continue; // prevent self-edges
			const mNode = graph.getNode(mid);
			if (!mNode || mNode.label === "Property") continue;
			if (mNode.properties.isAbstract === true) continue;
			if (mNode.properties.name !== methodName) continue;

			const mParamTypes =
				(mNode.properties.parameterTypes as string[] | undefined) ?? [];
			const mParamCount = mNode.properties.parameterCount as number | undefined;
			const ptResult = parameterTypesMatch(
				mParamTypes,
				targetParamTypes,
				mParamCount,
				targetParamCount,
			);
			if (ptResult.match) {
				implMatches.push({
					methodId: mid,
					parameterTypes: mParamTypes,
					confident: ptResult.confident,
				});
			}
		}

		// Walk this interface's parents (interface-extends-interface chains)
		const ifaceParents = parentMap.get(ifaceId) ?? [];
		for (const gp of ifaceParents) {
			if (!implVisited.has(gp)) implBfsQueue.push(gp);
		}
	}

	// Ambiguous: multiple interfaces provide the same default method
	if (implMatches.length === 1) return implMatches[0];
	return null; // 0 matches or ambiguous (>1)
}

/**
 * Build transitive edge types for a class using BFS from the class to all ancestors.
 *
 * Known limitation: BFS first-reach heuristic can misclassify an interface as
 * EXTENDS if it's reachable via a class chain before being seen via IMPLEMENTS.
 * E.g. if BaseClass also implements IFoo, IFoo may be classified as EXTENDS.
 * This affects C#/Java/Kotlin conflict resolution in rare diamond hierarchies.
 */
export function buildTransitiveEdgeTypes(
	classId: string,
	parentMap: Map<string, string[]>,
	parentEdgeType: Map<string, Map<string, "EXTENDS" | "IMPLEMENTS">>,
): Map<string, "EXTENDS" | "IMPLEMENTS"> {
	const result = new Map<string, "EXTENDS" | "IMPLEMENTS">();
	const directEdges = parentEdgeType.get(classId);
	if (!directEdges) return result;

	// BFS: propagate edge type from direct parents
	const queue: Array<{ id: string; edgeType: "EXTENDS" | "IMPLEMENTS" }> = [];
	const directParents = parentMap.get(classId) ?? [];

	for (const pid of directParents) {
		const et = directEdges.get(pid) ?? "EXTENDS";
		if (!result.has(pid)) {
			result.set(pid, et);
			queue.push({ id: pid, edgeType: et });
		}
	}

	while (queue.length > 0) {
		const { id, edgeType } = queue.shift()!;
		const grandparents = parentMap.get(id) ?? [];
		for (const gp of grandparents) {
			if (!result.has(gp)) {
				result.set(gp, edgeType);
				queue.push({ id: gp, edgeType });
			}
		}
	}

	return result;
}
