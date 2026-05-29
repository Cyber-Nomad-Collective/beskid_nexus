import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { parseRepoNameFromUrl } from '../../storage/git.js';
import { getGlobalDir, listRegisteredRepos, type RegistryEntry } from '../../storage/repo-manager.js';
import type {
  NexusCatalogEntry,
  NexusCatalogFile,
  PublicCatalogEntry,
} from './types.js';

const CATALOG_FILE = 'catalog.json';

const catalogPath = (): string => path.join(getGlobalDir(), CATALOG_FILE);

let writeChain: Promise<void> = Promise.resolve();

const withCatalogLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const emptyCatalog = (): NexusCatalogFile => ({ version: 1, entries: [] });

export const readCatalog = async (): Promise<NexusCatalogFile> => {
  try {
    const raw = await fs.readFile(catalogPath(), 'utf-8');
    const data = JSON.parse(raw) as NexusCatalogFile;
    if (data.version !== 1 || !Array.isArray(data.entries)) return emptyCatalog();
    return data;
  } catch {
    return emptyCatalog();
  }
};

const writeCatalog = async (catalog: NexusCatalogFile): Promise<void> => {
  const dir = getGlobalDir();
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${catalogPath()}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(catalog, null, 2), 'utf-8');
  await fs.rename(tmp, catalogPath());
};

export const slugifyCatalogId = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `repo-${randomUUID().slice(0, 8)}`;
};

export const listCatalogEntries = async (): Promise<NexusCatalogEntry[]> => {
  const catalog = await readCatalog();
  return [...catalog.entries].sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
};

export const getCatalogEntry = async (id: string): Promise<NexusCatalogEntry | null> => {
  const catalog = await readCatalog();
  return catalog.entries.find((e) => e.id === id) ?? null;
};

export const createCatalogEntry = async (
  input: Omit<NexusCatalogEntry, 'id' | 'createdAt' | 'updatedAt' | 'enabled' | 'sortOrder'> & {
    id?: string;
    enabled?: boolean;
    sortOrder?: number;
  },
): Promise<NexusCatalogEntry> => {
  return withCatalogLock(async () => {
    const catalog = await readCatalog();
    const id = input.id ? slugifyCatalogId(input.id) : slugifyCatalogId(input.displayName);
    if (catalog.entries.some((e) => e.id === id)) {
      throw new Error(`Catalog entry "${id}" already exists`);
    }
    const now = new Date().toISOString();
    const maxOrder = catalog.entries.reduce((m, e) => Math.max(m, e.sortOrder), -1);
    const entry: NexusCatalogEntry = {
      id,
      displayName: input.displayName.trim(),
      description: input.description.trim(),
      gitUrl: input.gitUrl.trim(),
      defaultBranch: input.defaultBranch?.trim() || undefined,
      enabled: input.enabled ?? true,
      sortOrder: input.sortOrder ?? maxOrder + 1,
      registryName: input.registryName,
      lastIndexedCommit: input.lastIndexedCommit,
      createdAt: now,
      updatedAt: now,
    };
    catalog.entries.push(entry);
    await writeCatalog(catalog);
    return entry;
  });
};

export const updateCatalogEntry = async (
  id: string,
  patch: Partial<
    Pick<
      NexusCatalogEntry,
      | 'displayName'
      | 'description'
      | 'gitUrl'
      | 'defaultBranch'
      | 'enabled'
      | 'sortOrder'
      | 'registryName'
      | 'lastIndexedCommit'
    >
  >,
): Promise<NexusCatalogEntry> => {
  return withCatalogLock(async () => {
    const catalog = await readCatalog();
    const idx = catalog.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(`Catalog entry "${id}" not found`);
    const existing = catalog.entries[idx]!;
    const updated: NexusCatalogEntry = {
      ...existing,
      ...patch,
      displayName: patch.displayName?.trim() ?? existing.displayName,
      description: patch.description?.trim() ?? existing.description,
      gitUrl: patch.gitUrl?.trim() ?? existing.gitUrl,
      defaultBranch:
        patch.defaultBranch !== undefined
          ? patch.defaultBranch?.trim() || undefined
          : existing.defaultBranch,
      updatedAt: new Date().toISOString(),
    };
    catalog.entries[idx] = updated;
    await writeCatalog(catalog);
    return updated;
  });
};

export const deleteCatalogEntry = async (id: string): Promise<void> => {
  return withCatalogLock(async () => {
    const catalog = await readCatalog();
    const next = catalog.entries.filter((e) => e.id !== id);
    if (next.length === catalog.entries.length) {
      throw new Error(`Catalog entry "${id}" not found`);
    }
    await writeCatalog({ version: 1, entries: next });
  });
};

export const markCatalogIndexed = async (
  id: string,
  registryName: string,
  lastIndexedCommit?: string,
): Promise<void> => {
  await updateCatalogEntry(id, { registryName, lastIndexedCommit });
};

/** Resolve a catalog row to a registered repo (name, remote URL, or git URL basename). */
export const resolveCatalogRegistryEntry = (
  entry: NexusCatalogEntry,
  repos: RegistryEntry[],
): RegistryEntry | undefined => {
  const repoByName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
  const repoByUrl = new Map<string, RegistryEntry>();
  for (const repo of repos) {
    if (repo.remoteUrl) {
      repoByUrl.set(normalizeGitRepoUrl(repo.remoteUrl), repo);
    }
  }

  const regName = (entry.registryName ?? entry.id).toLowerCase();
  const byName = repoByName.get(regName);
  if (byName) return byName;

  const byRemote = repoByUrl.get(normalizeGitRepoUrl(entry.gitUrl));
  if (byRemote) return byRemote;

  const urlRepoName = parseRepoNameFromUrl(entry.gitUrl);
  if (urlRepoName) {
    const byUrlBasename = repoByName.get(urlRepoName.toLowerCase());
    if (byUrlBasename) return byUrlBasename;
  }

  return undefined;
};

export const listPublicCatalog = async (): Promise<PublicCatalogEntry[]> => {
  const [entries, repos] = await Promise.all([
    listCatalogEntries(),
    listRegisteredRepos({ validate: true }),
  ]);

  return entries
    .filter((e) => e.enabled)
    .map((e) => {
      const reg = resolveCatalogRegistryEntry(e, repos);
      return {
        id: e.id,
        displayName: e.displayName,
        description: e.description,
        gitUrl: e.gitUrl,
        defaultBranch: e.defaultBranch,
        sortOrder: e.sortOrder,
        indexed: !!reg,
        registryName: reg?.name ?? e.registryName,
        lastIndexedCommit: e.lastIndexedCommit ?? reg?.lastCommit,
        indexedAt: reg?.indexedAt,
        stats: reg?.stats,
      };
    });
};

/** Normalize GitHub URLs for webhook / catalog matching. */
export const normalizeGitRepoUrl = (url: string): string => {
  const trimmed = url.trim().replace(/\.git$/i, '').replace(/\/$/, '');
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return `${u.protocol}//${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};

export const findCatalogByGitUrl = async (url: string): Promise<NexusCatalogEntry | null> => {
  const needle = normalizeGitRepoUrl(url);
  const entries = await listCatalogEntries();
  return (
    entries.find((e) => normalizeGitRepoUrl(e.gitUrl) === needle) ??
    null
  );
};
