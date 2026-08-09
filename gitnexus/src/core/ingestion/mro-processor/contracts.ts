import type { SupportedLanguages } from "gitnexus-shared";

export interface MROEntry {
	classId: string;
	className: string;
	language: SupportedLanguages;
	mro: string[]; // linearized parent names
	ambiguities: MethodAmbiguity[];
}

export interface MethodAmbiguity {
	methodName: string;
	definedIn: Array<{ classId: string; className: string; methodId: string }>;
	resolvedTo: string | null; // winning methodId or null if truly ambiguous
	reason: string;
}

export interface MROResult {
	entries: MROEntry[];
	overrideEdges: number;
	ambiguityCount: number;
	methodImplementsEdges: number;
}

export type MethodDef = { classId: string; className: string; methodId: string };
export type Resolution = {
	resolvedTo: string | null;
	reason: string;
	confidence: number;
};
