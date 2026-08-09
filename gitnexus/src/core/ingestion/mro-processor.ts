/**
 * MRO (Method Resolution Order) Processor
 *
 * Stable facade for inheritance linearization and member-resolution emission.
 */
export type {
	MethodAmbiguity,
	MROEntry,
	MROResult,
} from "./mro-processor/contracts.js";
export { computeMRO } from "./mro-processor/coordinator.js";
