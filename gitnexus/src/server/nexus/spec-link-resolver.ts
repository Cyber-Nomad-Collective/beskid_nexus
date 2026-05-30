import {
  ensureSpecLinkIndex,
  searchSpecPages,
  type SpecLinkIndexFile,
  type SpecSearchHit,
} from './spec-link-index.js';

export { searchSpecPages };

export const getSpecLinkIndex = async (): Promise<SpecLinkIndexFile> => ensureSpecLinkIndex();

export const resolveSpecLinksFromSearch = async (
  searchTerms: string[],
  limit = 3,
): Promise<Array<{ title: string; href: string }>> => {
  const index = await getSpecLinkIndex();
  const query = searchTerms.filter(Boolean).join(' ');
  const hits = searchSpecPages(index, query, limit);
  return hits.map((hit) => ({ title: hit.title, href: hit.href }));
};

export const validateHrefInIndex = async (href: string): Promise<boolean> => {
  const index = await getSpecLinkIndex();
  return index.pages.some((page) => page.href === href);
};

export type { SpecSearchHit };
