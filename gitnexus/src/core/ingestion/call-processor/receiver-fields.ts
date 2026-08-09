import { CLASS_LIKE_TYPES, stripNullable } from "./context.js";
import type { ResolutionContext } from "./context.js";

export interface FieldResolution {
	typeName: string; // resolved declared type (continues chain threading)
	fieldNodeId: string; // nodeId of the Property symbol (for ACCESSES edge target)
}

/**
 * Resolve the type that results from accessing `receiverName.fieldName`.
 * Requires declaredType on the Property node (needed for chain walking continuation).
 */
export const resolveFieldAccessType = (
	receiverName: string,
	fieldName: string,
	filePath: string,
	ctx: ResolutionContext,
): FieldResolution | undefined => {
	const fieldDef = resolveFieldOwnership(receiverName, fieldName, filePath, ctx);
	if (!fieldDef?.declaredType) return undefined;

	// Use stripNullable (not extractReturnTypeName) — field types like List<User>
	// should be preserved as-is, not unwrapped to User. Only strip nullable wrappers.
	return {
		typeName: stripNullable(fieldDef.declaredType),
		fieldNodeId: fieldDef.nodeId,
	};
};

/**
 * Resolve a field's Property node given a receiver type name and field name.
 * Does NOT require declaredType — used by write-access tracking where only the
 * fieldNodeId is needed (no chain continuation).
 */
export const resolveFieldOwnership = (
	receiverName: string,
	fieldName: string,
	filePath: string,
	ctx: ResolutionContext,
): { nodeId: string; declaredType?: string } | undefined => {
	const typeResolved = ctx.resolve(receiverName, filePath);
	if (!typeResolved) return undefined;
	const classDef = typeResolved.candidates.find((d) =>
		CLASS_LIKE_TYPES.has(d.type),
	);
	if (!classDef) return undefined;

	return (
		ctx.model.fields.lookupFieldByOwner(classDef.nodeId, fieldName) ?? undefined
	);
};
