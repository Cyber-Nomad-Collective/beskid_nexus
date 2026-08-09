import type { CaptureMatch } from "gitnexus-shared";
import type { Partitioned, Topic } from "./contracts.js";

/**
 * Bucket each match by the topic of its anchor capture. The anchor is the
 * capture whose name is prefixed with the match's topic (`@scope.*`,
 * `@declaration.*`, `@import.*`, `@type-binding.*`, `@reference.*`).
 *
 * A match may contain additional captures (e.g., `@import.source`,
 * `@declaration.class.name`) that are used by the provider hooks to
 * decode details. Those live inside the `CaptureMatch` and are surfaced
 * to hooks verbatim — the extractor itself only routes by anchor.
 */
export function partitionByTopic(
	matches: readonly CaptureMatch[],
): Partitioned {
	const scope: CaptureMatch[] = [];
	const declaration: CaptureMatch[] = [];
	const import_: CaptureMatch[] = [];
	const typeBinding: CaptureMatch[] = [];
	const reference: CaptureMatch[] = [];

	for (const match of matches) {
		const topic = topicOf(match);
		switch (topic) {
			case "scope":
				scope.push(match);
				break;
			case "declaration":
				declaration.push(match);
				break;
			case "import":
				import_.push(match);
				break;
			case "type-binding":
				typeBinding.push(match);
				break;
			case "reference":
				reference.push(match);
				break;
			case "unknown":
				// Unrecognized anchor — silently skip. Providers may emit extra
				// captures (e.g., `@comment`) that the extractor has no topic for.
				break;
		}
	}

	return { scope, declaration, import_, typeBinding, reference };
}

export function topicOf(match: CaptureMatch): Topic {
	// The anchor is the capture whose name uses one of the known topic
	// prefixes. For multi-capture matches, ALL captures share the topic;
	// we pick the first matching key for efficiency.
	for (const name of Object.keys(match)) {
		if (name.startsWith("@scope.")) return "scope";
		if (name.startsWith("@declaration.")) return "declaration";
		if (name.startsWith("@import.")) return "import";
		if (name.startsWith("@type-binding.")) return "type-binding";
		if (name.startsWith("@reference.")) return "reference";
	}
	return "unknown";
}
