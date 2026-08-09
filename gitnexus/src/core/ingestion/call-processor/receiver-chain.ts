import type {
	HeritageMap,
	MixedChainStep,
	ResolutionContext,
} from "./context.js";
import { extractReturnTypeName } from "./context.js";
import { resolveCallTarget } from "./coordinator.js";
import { resolveFieldAccessType } from "./receiver-fields.js";
import { resolveMethodByOwner } from "./receiver-member.js";
import type { OnFieldResolved } from "./receiver-member.js";
import { TYPE_PRESERVING_METHODS } from "./type-inference.js";

export const walkMixedChain = (
	chain: MixedChainStep[],
	startType: string,
	filePath: string,
	ctx: ResolutionContext,
	onFieldResolved?: OnFieldResolved,
	heritageMap?: HeritageMap,
): string | undefined => {
	let currentType: string | undefined = startType;
	for (const step of chain) {
		if (!currentType) break;
		if (step.kind === "field") {
			const resolved = resolveFieldAccessType(
				currentType,
				step.name,
				filePath,
				ctx,
			);
			if (!resolved) {
				currentType = undefined;
				break;
			}
			onFieldResolved?.(resolved.fieldNodeId);
			currentType = resolved.typeName;
		} else {
			const fieldResolved = resolveFieldAccessType(
				currentType,
				step.name,
				filePath,
				ctx,
			);
			if (fieldResolved) {
				onFieldResolved?.(fieldResolved.fieldNodeId);
				currentType = fieldResolved.typeName;
				continue;
			}
			const owned = resolveMethodByOwner(
				currentType,
				step.name,
				filePath,
				ctx,
				heritageMap,
			);
			if (owned?.def.returnType) {
				const fastRetType = extractReturnTypeName(owned.def.returnType);
				if (fastRetType) {
					currentType = fastRetType;
					continue;
				}
			}
			const resolved = resolveCallTarget(
				{
					calledName: step.name,
					callForm: "member",
					receiverTypeName: currentType,
				},
				filePath,
				ctx,
				undefined,
				undefined,
				undefined,
				heritageMap,
			);
			if (!resolved) {
				if (TYPE_PRESERVING_METHODS.has(step.name)) continue;
				currentType = undefined;
				break;
			}
			if (!resolved.returnType) {
				currentType = undefined;
				break;
			}
			const retType = extractReturnTypeName(resolved.returnType);
			if (!retType) {
				currentType = undefined;
				break;
			}
			currentType = retType;
		}
	}
	return currentType;
};
