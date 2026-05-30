import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { getGlobalDir } from '../../storage/repo-manager.js';

export interface SpecLinkPage {
  slug: string;
  title: string;
  href: string;
  headings: string[];
  /** Short excerpts for anti-copy validation only — never fed to doc prompts. */
  excerpts: string[];
}

export interface SpecLinkIndexFile {
  version: 1;
  builtAt: string;
  specRoot: string;
  pages: SpecLinkPage[];
}

export interface SpecSearchHit {
  title: string;
  href: string;
  relevance: number;
}

const INDEX_FILE = 'spec-link-index.json';

export const specLinkIndexPath = (): string => path.join(getGlobalDir(), INDEX_FILE);

export const defaultSpecRoot = (): string => {
  const env = process.env.NEXUS_SPEC_ROOT?.trim();
  if (env) return path.resolve(env);
  return path.resolve(process.cwd(), '../site/website/src/content/docs/platform-spec');
};

const parseFrontmatterTitle = (raw: string): string | null => {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const titleLine = match[1]!.split('\n').find((line) => line.startsWith('title:'));
  if (!titleLine) return null;
  const value = titleLine.slice('title:'.length).trim();
  return value.replace(/^['"]|['"]$/g, '') || null;
};

const extractHeadings = (body: string): string[] => {
  const headings: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^#{2,3}\s+(.+)$/);
    if (m) headings.push(m[1]!.trim());
  }
  return headings;
};

const extractExcerpts = (body: string, headings: string[]): string[] => {
  const excerpts = new Set<string>();
  for (const heading of headings) {
    if (heading.length >= 40) excerpts.add(heading);
  }
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s+/gm, '').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 40);
  for (const paragraph of paragraphs.slice(0, 8)) {
    excerpts.add(paragraph.slice(0, 240));
  }
  return [...excerpts];
};

export const mdxRelativePathToHref = (relativePath: string): string => {
  let slug = relativePath.replace(/\.mdx$/i, '').replace(/\\/g, '/');
  const isIndex = slug.endsWith('/index') || slug === 'index';
  if (slug.endsWith('/index')) slug = slug.slice(0, -('/index'.length));
  else if (slug === 'index') slug = '';
  const base = slug ? `/platform-spec/${slug}` : '/platform-spec';
  return isIndex ? `${base}/` : base;
};

export const buildSpecLinkIndex = async (specRoot: string): Promise<SpecLinkIndexFile> => {
  const resolvedRoot = path.resolve(specRoot);
  const pattern = path.join(resolvedRoot, '**/*.mdx').replace(/\\/g, '/');
  const files = await glob(pattern, { nodir: true });

  const pages: SpecLinkPage[] = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, 'utf-8');
    const relative = path.relative(resolvedRoot, filePath).replace(/\\/g, '/');
    const title = parseFrontmatterTitle(raw) ?? relative.replace(/\.mdx$/i, '');
    const body = raw.replace(/^---[\s\S]*?---\r?\n?/, '');
    const headings = extractHeadings(body);
    pages.push({
      slug: relative.replace(/\.mdx$/i, ''),
      title,
      href: mdxRelativePathToHref(relative),
      headings,
      excerpts: extractExcerpts(body, headings),
    });
  }

  pages.sort((a, b) => a.href.localeCompare(b.href));
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    specRoot: resolvedRoot,
    pages,
  };
};

export const saveSpecLinkIndex = async (index: SpecLinkIndexFile): Promise<void> => {
  const dir = getGlobalDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(specLinkIndexPath(), JSON.stringify(index, null, 2), 'utf-8');
};

export const loadSpecLinkIndex = async (): Promise<SpecLinkIndexFile | null> => {
  try {
    const raw = await fs.readFile(specLinkIndexPath(), 'utf-8');
    const data = JSON.parse(raw) as SpecLinkIndexFile;
    if (data.version !== 1 || !Array.isArray(data.pages)) return null;
    return data;
  } catch {
    return null;
  }
};

let cachedIndex: SpecLinkIndexFile | null = null;

export const ensureSpecLinkIndex = async (specRoot?: string): Promise<SpecLinkIndexFile> => {
  if (cachedIndex) return cachedIndex;
  const loaded = await loadSpecLinkIndex();
  if (loaded) {
    cachedIndex = loaded;
    return loaded;
  }
  const built = await buildSpecLinkIndex(specRoot ?? defaultSpecRoot());
  await saveSpecLinkIndex(built);
  cachedIndex = built;
  return built;
};

export const resetSpecLinkIndexCache = (): void => {
  cachedIndex = null;
};

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3);

export const searchSpecPages = (
  index: SpecLinkIndexFile,
  query: string,
  limit = 5,
): SpecSearchHit[] => {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored: SpecSearchHit[] = [];
  for (const page of index.pages) {
    const haystack = [page.title, page.slug, ...page.headings].join(' ').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += 1;
    }
    if (score > 0) {
      scored.push({ title: page.title, href: page.href, relevance: score / terms.length });
    }
  }

  return scored.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
};

export const allSpecExcerpts = (index: SpecLinkIndexFile): string[] =>
  index.pages.flatMap((page) => page.excerpts);

export const allSpecHrefs = (index: SpecLinkIndexFile): Set<string> =>
  new Set(index.pages.map((page) => page.href));
