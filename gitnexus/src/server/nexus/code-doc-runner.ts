import { createHash } from 'crypto';
import { fork, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'url';
import type { CodeDocRecord } from './types.js';
import {
  callOpenRouter,
  isOpenRouterConfigured,
  RESOLVE_SPEC_LINKS_TOOL,
  WRITE_CODE_DOC_TOOL,
  type OpenRouterMessage,
} from './openrouter-client.js';
import {
  allSpecExcerpts,
  allSpecHrefs,
  ensureSpecLinkIndex,
  searchSpecPages,
} from './spec-link-index.js';
import {
  containsSpecProse,
  dedupeSimilarCodeDocs,
  validateSpecLinks,
} from './code-doc-validator.js';
import {
  readCodeDocs,
  setCodeDocStatus,
  upsertCodeDocs,
} from './code-doc-store.js';
import { getStoragePath } from '../../storage/repo-manager.js';
import { logger } from '../../core/logger.js';

const _require = createRequire(import.meta.url);

export interface CodeDocEntity {
  entityId: string;
  entityKind: 'node' | 'cluster';
  name: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  neighborIds: string[];
  snippet?: string;
}

export interface RunCodeDocPipelineParams {
  registryName: string;
  repoPath: string;
  maxEntities?: number;
}

const hashContent = (entity: CodeDocEntity): string => {
  const payload = [
    entity.name,
    entity.filePath ?? '',
    entity.neighborIds.slice().sort().join(','),
  ].join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
};

const readSnippet = async (
  repoPath: string,
  filePath: string | undefined,
  startLine?: number,
  endLine?: number,
): Promise<string | undefined> => {
  if (!filePath) return undefined;
  const abs = path.isAbsolute(filePath) ? filePath : path.join(repoPath, filePath);
  try {
    const raw = await fs.readFile(abs, 'utf-8');
    const lines = raw.split('\n');
    if (startLine === undefined) return lines.slice(0, Math.min(40, lines.length)).join('\n');
    const start = Math.max(0, startLine);
    const end = Math.min(lines.length, (endLine ?? startLine) + 1);
    return lines.slice(start, Math.min(end, start + 40)).join('\n');
  } catch {
    return undefined;
  }
};

export const loadDocEntities = async (
  lbugPath: string,
  repoPath: string,
  maxEntities = 40,
): Promise<CodeDocEntity[]> => {
  const { executeQuery, withLbugDb } = await import('../../core/lbug/lbug-adapter.js');
  return withLbugDb(lbugPath, async () => {
    const entities: CodeDocEntity[] = [];

    const clusters = await executeQuery(`
      MATCH (c:Community)
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.symbolCount AS symbolCount
      ORDER BY c.symbolCount DESC
      LIMIT ${Math.max(5, Math.floor(maxEntities / 3))}
    `);

    for (const row of clusters) {
      const id = String(row.id ?? row[0]);
      const label = String(row.label ?? row.heuristicLabel ?? row[1] ?? id);
      const members = await executeQuery(`
        MATCH (n)-[:CodeRelation]->(c:Community {id: '${id.replace(/'/g, "''")}'})
        RETURN n.id AS id
        LIMIT 12
      `);
      entities.push({
        entityId: id,
        entityKind: 'cluster',
        name: label,
        neighborIds: members.map((m) => String(m.id ?? m[0])),
      });
    }

    const nodes = await executeQuery(`
      MATCH (n)-[r:CodeRelation]-()
      WHERE n.filePath IS NOT NULL
      RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, count(r) AS degree
      ORDER BY degree DESC
      LIMIT ${Math.max(10, maxEntities)}
    `);

    for (const row of nodes) {
      const entityId = String(row.id ?? row[0]);
      if (entities.some((e) => e.entityId === entityId)) continue;
      const filePath = row.filePath ? String(row.filePath) : undefined;
      const startLine = row.startLine !== undefined ? Number(row.startLine) : undefined;
      const endLine = row.endLine !== undefined ? Number(row.endLine) : undefined;
      const neighbors = await executeQuery(`
        MATCH (n {id: '${entityId.replace(/'/g, "''")}'})-[r:CodeRelation]-(m)
        RETURN m.id AS id
        LIMIT 12
      `);
      entities.push({
        entityId,
        entityKind: 'node',
        name: String(row.name ?? row[1] ?? entityId),
        filePath,
        startLine,
        endLine,
        neighborIds: neighbors.map((m) => String(m.id ?? m[0])),
        snippet: await readSnippet(repoPath, filePath, startLine, endLine),
      });
      if (entities.length >= maxEntities) break;
    }

    return entities.slice(0, maxEntities);
  });
};

const buildEntityContext = (entity: CodeDocEntity): string =>
  [
    `Entity kind: ${entity.entityKind}`,
    `Name: ${entity.name}`,
    entity.filePath ? `File: ${entity.filePath}` : null,
    entity.startLine !== undefined ? `Lines: ${entity.startLine}-${entity.endLine ?? entity.startLine}` : null,
    entity.neighborIds.length ? `Neighbors: ${entity.neighborIds.join(', ')}` : null,
    entity.snippet ? `Snippet:\n${entity.snippet}` : null,
  ]
    .filter(Boolean)
    .join('\n');

const generateCodeDocText = async (entity: CodeDocEntity): Promise<string | null> => {
  const messages: OpenRouterMessage[] = [
    {
      role: 'system',
      content:
        'Write concise repo-scoped documentation for the given graph entity. Describe what the code does in this repository. Do not restate Beskid platform spec or normative contracts.',
    },
    {
      role: 'user',
      content: buildEntityContext(entity),
    },
  ];

  const result = await callOpenRouter(messages, [WRITE_CODE_DOC_TOOL]);
  const writeCall = result.toolCalls.find((call) => call.name === 'write_code_doc');
  const codeDoc = typeof writeCall?.arguments.codeDoc === 'string' ? writeCall.arguments.codeDoc.trim() : '';
  if (codeDoc) return codeDoc;
  return result.message.content?.trim() || null;
};

const generateSpecLinks = async (entity: CodeDocEntity): Promise<Array<{ title: string; href: string }>> => {
  const index = await ensureSpecLinkIndex();
  const hrefIndex = allSpecHrefs(index);
  const messages: OpenRouterMessage[] = [
    {
      role: 'system',
      content:
        'Find up to three canonical platform spec pages related to this code. Call resolve_spec_links with search terms only. Do not invent hrefs.',
    },
    {
      role: 'user',
      content: buildEntityContext(entity),
    },
  ];

  const first = await callOpenRouter(messages, [RESOLVE_SPEC_LINKS_TOOL]);
  const resolveCall = first.toolCalls.find((call) => call.name === 'resolve_spec_links');
  const searchTerms = Array.isArray(resolveCall?.arguments.searchTerms)
    ? resolveCall!.arguments.searchTerms.map(String)
    : [entity.name];

  const hits = searchSpecPages(index, searchTerms.join(' '), 5);
  const candidates = hits.map((hit) => ({ title: hit.title, href: hit.href }));
  return validateSpecLinks(candidates, hrefIndex);
};

export const runCodeDocPipeline = async (params: RunCodeDocPipelineParams): Promise<void> => {
  const { registryName, repoPath, maxEntities = 40 } = params;
  const lbugPath = path.join(getStoragePath(repoPath), 'lbug');

  if (!isOpenRouterConfigured()) {
    await setCodeDocStatus(registryName, 'failed');
    logger.warn({ registryName }, 'Code doc pipeline skipped: OPENROUTER_API_KEY not set');
    return;
  }

  await setCodeDocStatus(registryName, 'running');
  await ensureSpecLinkIndex();

  try {
    const [entities, existing, specIndex] = await Promise.all([
      loadDocEntities(lbugPath, repoPath, maxEntities),
      readCodeDocs(registryName),
      ensureSpecLinkIndex(),
    ]);

    const existingById = new Map(existing.records.map((r) => [r.entityId, r]));
    const excerpts = allSpecExcerpts(specIndex);
    const hrefIndex = allSpecHrefs(specIndex);
    const nextRecords: CodeDocRecord[] = [];

    for (const entity of entities) {
      const contentHash = hashContent(entity);
      const cached = existingById.get(entity.entityId);
      if (cached && cached.contentHash === contentHash && cached.codeDoc) {
        nextRecords.push(cached);
        continue;
      }

      let codeDoc = await generateCodeDocText(entity);
      if (!codeDoc) continue;

      if (containsSpecProse(codeDoc, excerpts)) {
        logger.warn({ entityId: entity.entityId }, 'Rejected codeDoc containing spec prose');
        continue;
      }

      const specLinks = await generateSpecLinks(entity);
      const validatedLinks = validateSpecLinks(specLinks, hrefIndex);

      nextRecords.push({
        entityId: entity.entityId,
        entityKind: entity.entityKind,
        codeDoc,
        specLinks: validatedLinks,
        contentHash,
        updatedAt: new Date().toISOString(),
      });
    }

    const deduped = dedupeSimilarCodeDocs(nextRecords);
    await upsertCodeDocs(registryName, deduped, 'ready');
    await setCodeDocStatus(registryName, 'ready');
  } catch (err) {
    logger.error({ err, registryName }, 'Code doc pipeline failed');
    await setCodeDocStatus(registryName, 'failed');
    throw err;
  }
};

export interface StartCodeDocJobParams {
  registryName: string;
  repoPath: string;
  catalogEntryId?: string;
  maxEntities?: number;
}

export interface StartCodeDocJobResult {
  jobId: string;
  status: 'running' | 'skipped';
  reason?: string;
}

const activeJobs = new Map<string, { jobId: string; child: ChildProcess }>();

export const startCodeDocJob = async (
  params: StartCodeDocJobParams,
): Promise<StartCodeDocJobResult> => {
  const key = params.registryName.toLowerCase();
  const existing = activeJobs.get(key);
  if (existing) {
    return { jobId: existing.jobId, status: 'skipped', reason: 'code-doc job already running' };
  }

  const jobId = `${params.registryName}-${Date.now()}`;
  const callerPath = fileURLToPath(import.meta.url);
  const isDev = callerPath.endsWith('.ts');
  const workerFile = isDev ? 'code-doc-worker.ts' : 'code-doc-worker.js';
  const workerPath = path.join(path.dirname(callerPath), workerFile);
  const tsxHookArgs: string[] = isDev
    ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href]
    : [];

  const child = fork(workerPath, [], {
    execArgv: tsxHookArgs,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  activeJobs.set(key, { jobId, child });

  child.on('message', (msg: any) => {
    if (msg?.type === 'error') {
      logger.warn({ registryName: params.registryName, err: msg.message }, 'Code doc worker failed');
    }
  });

  child.on('exit', () => {
    activeJobs.delete(key);
  });

  child.send({
    type: 'start',
    registryName: params.registryName,
    repoPath: params.repoPath,
    maxEntities: params.maxEntities,
  });

  return { jobId, status: 'running' };
};
