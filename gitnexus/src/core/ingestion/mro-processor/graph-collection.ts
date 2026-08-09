import type { KnowledgeGraph } from "../../graph/types.js";

/** Collect EXTENDS, IMPLEMENTS, and HAS_METHOD adjacency from the graph. */
export function buildAdjacency(graph: KnowledgeGraph) {
	// parentMap: childId → parentIds[] (in insertion / declaration order)
	const parentMap = new Map<string, string[]>();
	// methodMap: classId → methodIds[]
	const methodMap = new Map<string, string[]>();
	// Track which edge type each parent link came from
	const parentEdgeType = new Map<
		string,
		Map<string, "EXTENDS" | "IMPLEMENTS">
	>();

	// Three typed iterations replace one full-relationship-map scan
	// with per-edge type checks. Each consumes only the edges of the
	// type it cares about — see plan
	// docs/plans/2026-04-20-002-perf-parse-heritage-mro-plan.md (Unit 2).
	for (const rel of graph.iterRelationshipsByType("EXTENDS")) {
		let parents = parentMap.get(rel.sourceId);
		if (!parents) {
			parents = [];
			parentMap.set(rel.sourceId, parents);
		}
		parents.push(rel.targetId);

		let edgeTypes = parentEdgeType.get(rel.sourceId);
		if (!edgeTypes) {
			edgeTypes = new Map();
			parentEdgeType.set(rel.sourceId, edgeTypes);
		}
		edgeTypes.set(rel.targetId, "EXTENDS");
	}
	for (const rel of graph.iterRelationshipsByType("IMPLEMENTS")) {
		let parents = parentMap.get(rel.sourceId);
		if (!parents) {
			parents = [];
			parentMap.set(rel.sourceId, parents);
		}
		parents.push(rel.targetId);

		let edgeTypes = parentEdgeType.get(rel.sourceId);
		if (!edgeTypes) {
			edgeTypes = new Map();
			parentEdgeType.set(rel.sourceId, edgeTypes);
		}
		edgeTypes.set(rel.targetId, "IMPLEMENTS");
	}
	for (const rel of graph.iterRelationshipsByType("HAS_METHOD")) {
		let methods = methodMap.get(rel.sourceId);
		if (!methods) {
			methods = [];
			methodMap.set(rel.sourceId, methods);
		}
		methods.push(rel.targetId);
	}

	return { parentMap, methodMap, parentEdgeType };
}
