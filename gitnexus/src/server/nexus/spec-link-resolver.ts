import {
	ensureSpecLinkIndex,
	type SpecLinkIndexFile,
	type SpecSearchHit,
	searchSpecPages,
} from "./spec-link-index.js";
import type { StandardLink } from "./types.js";

export { searchSpecPages };

export const getSpecLinkIndex = async (): Promise<SpecLinkIndexFile> =>
	ensureSpecLinkIndex();

export const resolveSpecLinksFromSearch = async (
	searchTerms: string[],
	limit = 3,
): Promise<StandardLink[]> => {
	const index = await getSpecLinkIndex();
	const query = searchTerms.filter(Boolean).join(" ");
	const hits = searchSpecPages(index, query, limit);
	return hits.map((hit) => ({
		type: "spec",
		stableId: hit.stableId,
		title: hit.title,
		href: hit.href,
		revision: hit.revision,
	}));
};

export const validateHrefInIndex = async (href: string): Promise<boolean> => {
	const index = await getSpecLinkIndex();
	return index.pages.some((page) => page.href === href);
};

export type { SpecSearchHit };
