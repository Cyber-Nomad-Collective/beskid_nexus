import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSpecLinkIndex,
  mdxRelativePathToHref,
  resetSpecLinkIndexCache,
  saveSpecLinkIndex,
  searchSpecPages,
} from '../../src/server/nexus/spec-link-index.js';

describe('mdxRelativePathToHref', () => {
  it('maps index pages to trailing-slash hrefs', () => {
    expect(mdxRelativePathToHref('tooling/nexus/index.mdx')).toBe('/platform-spec/tooling/nexus/');
    expect(mdxRelativePathToHref('tooling/nexus/design-model.mdx')).toBe(
      '/platform-spec/tooling/nexus/design-model',
    );
  });
});

describe('buildSpecLinkIndex', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-spec-index-'));
    await fs.mkdir(path.join(tempRoot, 'tooling/nexus'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'tooling/nexus/index.mdx'),
      `---
title: Beskid Nexus
---
## Graph-first explorer
Public graph explorer for indexed repositories.
`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempRoot, 'tooling/nexus/design-model.mdx'),
      `---
title: Nexus design model
---
## Code documentation
Repo-scoped code docs stay separate from platform spec.
`,
      'utf-8',
    );
  });

  afterEach(async () => {
    resetSpecLinkIndexCache();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('indexes title, href, and headings without storing prompt bodies', async () => {
    const index = await buildSpecLinkIndex(tempRoot);
    expect(index.pages).toHaveLength(2);
    expect(index.pages.find((p) => p.href === '/platform-spec/tooling/nexus/')).toMatchObject({
      title: 'Beskid Nexus',
      headings: ['Graph-first explorer'],
    });
    for (const page of index.pages) {
      expect(page.headings.length).toBeGreaterThan(0);
      expect(page.excerpts.length).toBeGreaterThan(0);
    }
  });

  it('searches indexed pages by query terms', async () => {
    const index = await buildSpecLinkIndex(tempRoot);
    const hits = searchSpecPages(index, 'code documentation repo scoped', 3);
    expect(hits[0]?.href).toBe('/platform-spec/tooling/nexus/design-model');
    expect(hits[0]?.relevance).toBeGreaterThan(0);
  });

  it('persists and reloads from GITNEXUS_HOME', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-home-'));
    const previousHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tempHome;
    try {
      const built = await buildSpecLinkIndex(tempRoot);
      await saveSpecLinkIndex(built);
      resetSpecLinkIndexCache();
      const { loadSpecLinkIndex } = await import('../../src/server/nexus/spec-link-index.js');
      const loaded = await loadSpecLinkIndex();
      expect(loaded?.pages).toHaveLength(2);
    } finally {
      process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });
});
