import { describe, expect, it } from 'vitest';

import {
  normalizeGitRepoUrl,
  resolveCatalogRegistryEntry,
  type NexusCatalogEntry,
} from '../../src/server/nexus/catalog-store.js';
import type { RegistryEntry } from '../../src/storage/repo-manager.js';

const catalogEntry = (overrides: Partial<NexusCatalogEntry> = {}): NexusCatalogEntry => ({
  id: 'beskid-lang',
  displayName: 'Beskid',
  description: '',
  gitUrl: 'https://github.com/cyber-nomad-collective/beskid',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const registryEntry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
  name: 'beskid',
  path: '/data/repos/beskid',
  storagePath: '/data/repos/beskid/.gitnexus',
  indexedAt: '2026-01-01T00:00:00.000Z',
  lastCommit: 'abc123',
  remoteUrl: 'https://github.com/cyber-nomad-collective/beskid.git',
  ...overrides,
});

describe('resolveCatalogRegistryEntry', () => {
  it('matches by registry name/id first', () => {
    const reg = resolveCatalogRegistryEntry(
      catalogEntry({ registryName: 'beskid' }),
      [registryEntry()],
    );
    expect(reg?.name).toBe('beskid');
  });

  it('matches by normalized git URL when catalog id differs from registry name', () => {
    const reg = resolveCatalogRegistryEntry(catalogEntry(), [registryEntry()]);
    expect(reg?.name).toBe('beskid');
  });

  it('matches by git URL basename', () => {
    const reg = resolveCatalogRegistryEntry(catalogEntry(), [
      registryEntry({ remoteUrl: undefined, name: 'beskid' }),
    ]);
    expect(reg?.name).toBe('beskid');
  });
});

describe('normalizeGitRepoUrl', () => {
  it('normalizes github URLs consistently', () => {
    expect(normalizeGitRepoUrl('https://github.com/org/Repo.git')).toBe(
      'https://github.com/org/repo',
    );
  });
});
