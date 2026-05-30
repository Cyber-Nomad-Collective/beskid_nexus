import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codeDocFilePath,
  pruneStale,
  readCodeDocs,
  setCodeDocStatus,
  upsertCodeDoc,
} from '../../src/server/nexus/code-doc-store.js';

describe('code-doc-store', () => {
  let tempHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-code-docs-'));
    previousHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tempHome;
  });

  afterEach(async () => {
    process.env.GITNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('reads empty store when file is missing', async () => {
    const file = await readCodeDocs('demo');
    expect(file).toEqual({ version: 1, docStatus: 'idle', records: [] });
  });

  it('upserts and reads code doc records', async () => {
    await upsertCodeDoc('demo', {
      entityId: 'node-1',
      entityKind: 'node',
      codeDoc: 'Indexes symbols in this repository.',
      specLinks: [{ title: 'Nexus', href: '/platform-spec/tooling/nexus/' }],
      contentHash: 'abc123',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });

    const file = await readCodeDocs('demo');
    expect(file.records).toHaveLength(1);
    expect(file.records[0]?.entityId).toBe('node-1');
    expect(await fs.readFile(codeDocFilePath('demo'), 'utf-8')).toContain('Indexes symbols');
  });

  it('updates doc status and prunes stale entity ids', async () => {
    await upsertCodeDoc('demo', {
      entityId: 'node-1',
      entityKind: 'node',
      codeDoc: 'Keep me',
      specLinks: [],
      contentHash: 'a',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
    await upsertCodeDoc('demo', {
      entityId: 'node-2',
      entityKind: 'node',
      codeDoc: 'Drop me',
      specLinks: [],
      contentHash: 'b',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });

    await setCodeDocStatus('demo', 'ready');
    await pruneStale('demo', new Set(['node-1']));

    const file = await readCodeDocs('demo');
    expect(file.docStatus).toBe('ready');
    expect(file.records.map((r) => r.entityId)).toEqual(['node-1']);
  });
});
