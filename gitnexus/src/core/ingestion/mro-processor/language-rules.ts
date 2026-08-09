import type { MethodDef, Resolution } from "./contracts.js";

/** Resolve by MRO order — first ancestor in linearized order wins. */
export function resolveByMroOrder(
	methodName: string,
	defs: MethodDef[],
	mroOrder: string[],
	reasonPrefix: string,
): Resolution {
	for (const ancestorId of mroOrder) {
		const match = defs.find((d) => d.classId === ancestorId);
		if (match) {
			return {
				resolvedTo: match.methodId,
				reason: `${reasonPrefix}: ${match.className}::${methodName}`,
				confidence: 0.9, // MRO-ordered resolution
			};
		}
	}
	return {
		resolvedTo: defs[0].methodId,
		reason: `${reasonPrefix} fallback: first definition`,
		confidence: 0.7,
	};
}

export function resolveCsharpJava(
	methodName: string,
	defs: MethodDef[],
	parentEdgeTypes: Map<string, "EXTENDS" | "IMPLEMENTS"> | undefined,
): Resolution {
	const classDefs: MethodDef[] = [];
	const interfaceDefs: MethodDef[] = [];

	for (const def of defs) {
		const edgeType = parentEdgeTypes?.get(def.classId);
		if (edgeType === "IMPLEMENTS") {
			interfaceDefs.push(def);
		} else {
			classDefs.push(def);
		}
	}

	if (classDefs.length > 0) {
		return {
			resolvedTo: classDefs[0].methodId,
			reason: `class method wins: ${classDefs[0].className}::${methodName}`,
			confidence: 0.95, // Class method is authoritative
		};
	}

	if (interfaceDefs.length > 1) {
		return {
			resolvedTo: null,
			reason: `ambiguous: ${methodName} defined in multiple interfaces: ${interfaceDefs.map((d) => d.className).join(", ")}`,
			confidence: 0.5,
		};
	}

	if (interfaceDefs.length === 1) {
		return {
			resolvedTo: interfaceDefs[0].methodId,
			reason: `single interface default: ${interfaceDefs[0].className}::${methodName}`,
			confidence: 0.85, // Single interface, unambiguous
		};
	}

	return { resolvedTo: null, reason: "no resolution found", confidence: 0.5 };
}
