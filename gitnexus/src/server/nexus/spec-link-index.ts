import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { getGlobalDir } from "../../storage/repo-manager.js";
import type { TrackerDeliveryNode, TrackerDeliveryRelation } from "./types.js";

type UnknownRecord = Record<string, unknown>;

export interface SpecLinkPage {
	stableId?: string;
	slug: string;
	title: string;
	href: string;
	aliases: string[];
	headings: string[];
	/** Short excerpts for anti-copy validation only — never fed to doc prompts. */
	excerpts: string[];
	relations: SpecCatalogRelation[];
}

export interface SpecCatalogRelation {
	type: string;
	title: string;
	href: string;
	relation: string;
}

export interface SpecLinkIndexFile {
	version: 2;
	builtAt: string;
	revision: string;
	sourceHash: string;
	catalogPath: string;
	pages: SpecLinkPage[];
}

export interface SpecSearchHit {
	stableId?: string;
	title: string;
	href: string;
	revision: string;
	relevance: number;
}

export interface TrackerDeliveryLinkInput {
	trackerId: string;
	catalogRevision: string;
	standardId: string;
	relation: TrackerDeliveryRelation["relation"];
}

const INDEX_FILE = "spec-link-index.json";

const requiredTrackerLinkPart = (value: string, name: string): string => {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`Tracker delivery link requires ${name}`);
	return trimmed;
};

/** Stable graph identity prevents a Tracker ID from crossing catalog revisions. */
export const trackerDeliveryNodeId = (
	trackerId: string,
	catalogRevision: string,
): string =>
	`tracker:${requiredTrackerLinkPart(trackerId, "tracker ID")}:${requiredTrackerLinkPart(catalogRevision, "catalog revision")}`;

export const trackerDeliveryNode = (
	trackerId: string,
	catalogRevision: string,
): TrackerDeliveryNode => ({
	id: trackerDeliveryNodeId(trackerId, catalogRevision),
	trackerId: requiredTrackerLinkPart(trackerId, "tracker ID"),
	catalogRevision: requiredTrackerLinkPart(catalogRevision, "catalog revision"),
});

/** Converts Tracker's revisioned typed link contract into a Nexus graph edge. */
export const trackerDeliveryRelation = (
	input: TrackerDeliveryLinkInput,
): TrackerDeliveryRelation => {
	const catalogRevision = requiredTrackerLinkPart(
		input.catalogRevision,
		"catalog revision",
	);
	const standardId = requiredTrackerLinkPart(input.standardId, "standard ID");
	const from = trackerDeliveryNodeId(input.trackerId, catalogRevision);
	const to = `openspec:${standardId}:${catalogRevision}`;
	return {
		id: `${from}->${to}`,
		from,
		to,
		relation: input.relation,
		catalogRevision,
	};
};

export const specLinkIndexPath = (): string =>
	path.join(getGlobalDir(), INDEX_FILE);

export const defaultSpecCatalogPath = (): string => {
	const configured =
		process.env.NEXUS_OPEN_SPEC_CATALOG?.trim() ??
		process.env.NEXUS_SPEC_CATALOG?.trim() ??
		process.env.NEXUS_SPEC_ROOT?.trim();
	if (configured) {
		const resolved = path.resolve(configured);
		return path.extname(resolved).toLowerCase() === ".json"
			? resolved
			: path.join(resolved, "openspec", "catalog.json");
	}
	return path.resolve(process.cwd(), "../../openspec/catalog.json");
};

/** @deprecated The spec input is now a catalog file, not an MDX root. */
export const defaultSpecRoot = defaultSpecCatalogPath;

const asRecord = (value: unknown): UnknownRecord | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;

const firstString = (
	record: UnknownRecord,
	keys: string[],
): string | undefined => {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
};

const stringArray = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];

const aliasesFor = (record: UnknownRecord): string[] => {
	const aliases = Array.isArray(record.aliases) ? record.aliases : [];
	return [
		...stringArray(record.legacySlugs),
		...stringArray(record.legacy_slugs),
		...aliases.flatMap((alias) => {
			if (typeof alias === "string") return [alias];
			const value = asRecord(alias);
			const slug = value
				? firstString(value, ["slug", "path", "href", "url"])
				: undefined;
			return slug ? [slug] : [];
		}),
	];
};

const normalizeSlug = (value: string): string =>
	value
		.replace(/^https?:\/\/[^/]+/i, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");

const normalizeHref = (value: string): string => {
	const withoutOrigin = value.replace(/^https?:\/\/[^/]+/i, "");
	return withoutOrigin.startsWith("/") ? withoutOrigin : `/${withoutOrigin}`;
};

const excerptStrings = (record: UnknownRecord): string[] => {
	const values = [
		firstString(record, [
			"normativeText",
			"normative_text",
			"text",
			"body",
			"description",
		]),
		...stringArray(record.excerpts),
	].filter((value): value is string => Boolean(value));
	return values
		.map((value) => value.replace(/\s+/g, " ").trim().slice(0, 240))
		.filter((value) => value.length >= 40)
		.slice(0, 8);
};

const relationsFor = (record: UnknownRecord): SpecCatalogRelation[] =>
	(Array.isArray(record.relations) ? record.relations : []).flatMap((value) => {
		const relation = asRecord(value);
		if (!relation) return [];
		const type = firstString(relation, ["type"]);
		const title = firstString(relation, ["title"]);
		const href = firstString(relation, ["href", "url"]);
		const label = firstString(relation, ["relation", "label"]);
		return type && title && href && label
			? [{ type, title, href: normalizeHref(href), relation: label }]
			: [];
	});

const entryToPage = (value: unknown): SpecLinkPage | null => {
	const record = asRecord(value);
	if (!record) return null;
	const stableId = firstString(record, [
		"stableId",
		"stable_id",
		"id",
		"requirementId",
		"capabilityId",
	]);
	const aliases = aliasesFor(record);
	const rawSlug =
		firstString(record, ["slug", "legacySlug", "capabilityPath", "path"]) ??
		aliases[0] ??
		stableId;
	const title = firstString(record, ["title", "name", "summary"]);
	if (!rawSlug || !title) return null;
	const slug = normalizeSlug(rawSlug);
	const href = normalizeHref(
		firstString(record, ["canonicalUrl", "canonical_url", "href", "url"]) ??
			`/${slug}/`,
	);
	const headings = [
		...stringArray(record.headings),
		firstString(record, [
			"requirementAnchor",
			"requirement_anchor",
			"capability",
		]),
	].filter((value): value is string => Boolean(value));

	return {
		stableId,
		slug,
		title,
		href,
		aliases,
		headings,
		excerpts: excerptStrings(record),
		relations: relationsFor(record),
	};
};

const entryAndRequirementPages = (value: unknown): SpecLinkPage[] => {
	const parent = entryToPage(value);
	const record = asRecord(value);
	if (!parent || !record || !Array.isArray(record.requirements))
		return parent ? [parent] : [];
	const requirements = record.requirements.flatMap(
		(requirement): SpecLinkPage[] => {
			const item = asRecord(requirement);
			if (!item) return [];
			const stableId = firstString(item, ["stableId", "stable_id", "id"]);
			const title = firstString(item, ["title", "name", "summary"]);
			const anchor = firstString(item, [
				"anchor",
				"requirementAnchor",
				"requirement_anchor",
			]);
			if (!title || !anchor) return [];
			const legacySlug = firstString(item, ["legacySlug", "legacy_slug"]);
			return [
				{
					stableId,
					slug: `${parent.slug}#${anchor}`,
					title,
					href: `${parent.href.replace(/#.*$/, "")}#${anchor}`,
					aliases: legacySlug ? [legacySlug] : [],
					headings: [title],
					excerpts: excerptStrings(item),
					relations: [],
				},
			];
		},
	);
	return [parent, ...requirements];
};

const sourceHashFor = (raw: string): string =>
	createHash("sha256").update(raw).digest("hex");

export const buildSpecLinkIndex = async (
	catalogPath: string,
): Promise<SpecLinkIndexFile> => {
	const resolvedCatalogPath = path.resolve(catalogPath);
	const raw = await fs.readFile(resolvedCatalogPath, "utf-8");
	const sourceHash = sourceHashFor(raw);
	const root = asRecord(JSON.parse(raw));
	if (!root)
		throw new Error(`Invalid OpenSpec catalog object: ${resolvedCatalogPath}`);
	const nestedCatalog = asRecord(root.catalog);
	const entries = Array.isArray(root.entries)
		? root.entries
		: Array.isArray(nestedCatalog?.entries)
			? nestedCatalog.entries
			: [];
	const revision =
		firstString(root, ["revision", "catalogRevision", "catalog_revision"]) ??
		sourceHash;
	const pages = entries
		.flatMap(entryAndRequirementPages)
		.sort((a, b) => a.href.localeCompare(b.href));
	if (pages.length === 0) {
		throw new Error(
			`OpenSpec catalog contains no linkable entries: ${resolvedCatalogPath}`,
		);
	}

	return {
		version: 2,
		builtAt: new Date().toISOString(),
		revision,
		sourceHash,
		catalogPath: resolvedCatalogPath,
		pages,
	};
};

export const saveSpecLinkIndex = async (
	index: SpecLinkIndexFile,
): Promise<void> => {
	const dir = getGlobalDir();
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		specLinkIndexPath(),
		JSON.stringify(index, null, 2),
		"utf-8",
	);
};

export const loadSpecLinkIndex =
	async (): Promise<SpecLinkIndexFile | null> => {
		try {
			const raw = await fs.readFile(specLinkIndexPath(), "utf-8");
			const data = JSON.parse(raw) as SpecLinkIndexFile;
			if (
				data.version !== 2 ||
				typeof data.revision !== "string" ||
				typeof data.sourceHash !== "string" ||
				!Array.isArray(data.pages)
			) {
				return null;
			}
			return data;
		} catch {
			return null;
		}
	};

let cachedIndex: SpecLinkIndexFile | null = null;

export const ensureSpecLinkIndex = async (
	catalogPath?: string,
): Promise<SpecLinkIndexFile> => {
	const current = await buildSpecLinkIndex(
		catalogPath ?? defaultSpecCatalogPath(),
	);
	if (
		cachedIndex?.catalogPath === current.catalogPath &&
		cachedIndex.sourceHash === current.sourceHash
	) {
		return cachedIndex;
	}

	const persisted = await loadSpecLinkIndex();
	if (
		persisted?.catalogPath === current.catalogPath &&
		persisted.sourceHash === current.sourceHash
	) {
		cachedIndex = persisted;
		return persisted;
	}

	await saveSpecLinkIndex(current);
	cachedIndex = current;
	return current;
};

export const resetSpecLinkIndexCache = (): void => {
	cachedIndex = null;
};

const tokenize = (value: string): string[] =>
	value
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.filter((token) => token.length >= 3);

export const searchSpecPages = (
	index: SpecLinkIndexFile,
	query: string,
	limit = 5,
): SpecSearchHit[] => {
	const terms = tokenize(query);
	if (terms.length === 0) return [];

	const scored: SpecSearchHit[] = [];
	for (const page of index.pages) {
		const haystack = [
			page.stableId,
			page.title,
			page.slug,
			...page.aliases,
			...page.headings,
			...page.relations.flatMap((relation) => [
				relation.type,
				relation.title,
				relation.href,
				relation.relation,
			]),
		]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		let score = 0;
		for (const term of terms) {
			if (haystack.includes(term)) score += 1;
		}
		if (score > 0) {
			scored.push({
				stableId: page.stableId,
				title: page.title,
				href: page.href,
				revision: index.revision,
				relevance: score / terms.length,
			});
		}
	}

	return scored.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
};

export const allSpecExcerpts = (index: SpecLinkIndexFile): string[] =>
	index.pages.flatMap((page) => page.excerpts);

export const allSpecHrefs = (index: SpecLinkIndexFile): Set<string> =>
	new Set(index.pages.map((page) => page.href));
