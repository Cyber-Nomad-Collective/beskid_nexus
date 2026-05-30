import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getGlobalDir } from '../../storage/repo-manager.js';
import type { CodeDocRecord } from './types.js';

export type DocStatus = 'idle' | 'running' | 'failed' | 'ready';

export interface CodeDocFile {
  version: 1;
  docStatus: DocStatus;
  records: CodeDocRecord[];
}

const emptyFile = (): CodeDocFile => ({ version: 1, docStatus: 'idle', records: [] });

const codeDocsDir = (): string => path.join(getGlobalDir(), 'code-docs');

export const codeDocFilePath = (registryName: string): string =>
  path.join(codeDocsDir(), `${registryName}.json`);

let writeChain: Promise<void> = Promise.resolve();

const withWriteLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

export const readCodeDocs = async (registryName: string): Promise<CodeDocFile> => {
  try {
    const raw = await fs.readFile(codeDocFilePath(registryName), 'utf-8');
    const data = JSON.parse(raw) as CodeDocFile;
    if (data.version !== 1 || !Array.isArray(data.records)) return emptyFile();
    return {
      version: 1,
      docStatus: data.docStatus ?? 'idle',
      records: data.records,
    };
  } catch {
    return emptyFile();
  }
};

export const readCodeDocStatus = async (registryName: string): Promise<DocStatus> => {
  const file = await readCodeDocs(registryName);
  return file.docStatus;
};

export const setCodeDocStatus = async (
  registryName: string,
  docStatus: DocStatus,
): Promise<void> => {
  return withWriteLock(async () => {
    const file = await readCodeDocs(registryName);
    file.docStatus = docStatus;
    await writeCodeDocFile(registryName, file);
  });
};

const writeCodeDocFile = async (registryName: string, file: CodeDocFile): Promise<void> => {
  const dir = codeDocsDir();
  await fs.mkdir(dir, { recursive: true });
  const target = codeDocFilePath(registryName);
  const tmp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await fs.rename(tmp, target);
};

export const upsertCodeDoc = async (
  registryName: string,
  record: CodeDocRecord,
): Promise<void> => {
  return withWriteLock(async () => {
    const file = await readCodeDocs(registryName);
    const idx = file.records.findIndex((r) => r.entityId === record.entityId);
    if (idx >= 0) {
      file.records[idx] = record;
    } else {
      file.records.push(record);
    }
    await writeCodeDocFile(registryName, file);
  });
};

export const upsertCodeDocs = async (
  registryName: string,
  records: CodeDocRecord[],
  docStatus: DocStatus = 'ready',
): Promise<void> => {
  return withWriteLock(async () => {
    const file = await readCodeDocs(registryName);
    const byId = new Map(file.records.map((r) => [r.entityId, r]));
    for (const record of records) {
      byId.set(record.entityId, record);
    }
    file.records = [...byId.values()];
    file.docStatus = docStatus;
    await writeCodeDocFile(registryName, file);
  });
};

export const pruneStale = async (
  registryName: string,
  entityIds: Set<string>,
): Promise<void> => {
  return withWriteLock(async () => {
    const file = await readCodeDocs(registryName);
    file.records = file.records.filter((r) => entityIds.has(r.entityId));
    await writeCodeDocFile(registryName, file);
  });
};

export const codeDocsByEntityId = async (
  registryName: string,
): Promise<Map<string, CodeDocRecord>> => {
  const file = await readCodeDocs(registryName);
  return new Map(file.records.map((r) => [r.entityId, r]));
};
