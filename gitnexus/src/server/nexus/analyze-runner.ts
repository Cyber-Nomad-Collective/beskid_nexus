import { fork } from 'child_process';
import path from 'path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'url';
import type { LocalBackend } from '../../mcp/local/local-backend.js';
import { logger } from '../../core/logger.js';
import { getStoragePath, loadMeta } from '../../storage/repo-manager.js';
import { extractRepoName, getCloneDir, cloneOrPull } from '../git-clone.js';
import type { JobManager } from '../analyze-job.js';
import { markCatalogIndexed } from './catalog-store.js';
import { startCodeDocJob } from './code-doc-runner.js';
import { getRemoteHead } from './remote-git.js';

const _require = createRequire(import.meta.url);

export interface StartAnalyzeParams {
  repoUrl?: string;
  repoPath?: string;
  force?: boolean;
  embeddings?: boolean;
  dropEmbeddings?: boolean;
  registryName?: string;
  catalogEntryId?: string;
  skipIfCommit?: string;
  defaultBranch?: string;
}

export interface AnalyzeRunnerDeps {
  jobManager: JobManager;
  backend: LocalBackend;
  acquireRepoLock: (repoPath: string) => string | null;
  releaseRepoLock: (repoPath: string) => void;
}

export const startAnalyzeJob = async (
  deps: AnalyzeRunnerDeps,
  params: StartAnalyzeParams,
): Promise<{ jobId: string; status: string; skipped?: boolean; reason?: string }> => {
  const { jobManager, backend, acquireRepoLock, releaseRepoLock } = deps;

  if (params.repoUrl && params.skipIfCommit) {
    const remote = await getRemoteHead(params.repoUrl, params.defaultBranch);
    if (remote && remote === params.skipIfCommit) {
      return { jobId: '', status: 'skipped', skipped: true, reason: 'already indexed at HEAD' };
    }
  }

  const job = jobManager.createJob({
    repoUrl: params.repoUrl,
    repoPath: params.repoPath,
  });

  if (job.status !== 'queued') {
    return { jobId: job.id, status: job.status };
  }

  jobManager.updateJob(job.id, { status: 'cloning' });

  (async () => {
    let targetPath = params.repoPath;
    const catalogEntryId = params.catalogEntryId;
    try {
      if (params.repoUrl && !params.repoPath) {
        const repoName = extractRepoName(params.repoUrl);
        targetPath = getCloneDir(repoName);

        jobManager.updateJob(job.id, {
          status: 'cloning',
          repoName,
          progress: { phase: 'cloning', percent: 0, message: `Cloning ${params.repoUrl}...` },
        });

        await cloneOrPull(params.repoUrl, targetPath, (progress) => {
          jobManager.updateJob(job.id, {
            progress: { phase: progress.phase, percent: 5, message: progress.message },
          });
        });
      }

      if (!targetPath) {
        throw new Error('No target path resolved');
      }

      const analyzeLockKey = getStoragePath(targetPath);
      const lockErr = acquireRepoLock(analyzeLockKey);
      if (lockErr) {
        jobManager.updateJob(job.id, { status: 'failed', error: lockErr });
        return;
      }

      jobManager.updateJob(job.id, { repoPath: targetPath, status: 'analyzing' });

      const MAX_WORKER_RETRIES = 2;
      const callerPath = fileURLToPath(import.meta.url);
      const isDev = callerPath.endsWith('.ts');
      const workerFile = isDev ? 'analyze-worker.ts' : 'analyze-worker.js';
      const workerPath = path.join(path.dirname(callerPath), '..', workerFile);
      const tsxHookArgs: string[] = isDev
        ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href]
        : [];

      const forkWorker = () => {
        const currentJob = jobManager.getJob(job.id);
        if (!currentJob || currentJob.status === 'complete' || currentJob.status === 'failed') {
          return;
        }

        const child = fork(workerPath, [], {
          execArgv: [...tsxHookArgs, '--max-old-space-size=8192'],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });

        let stderrChunks = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrChunks += chunk.toString();
          if (stderrChunks.length > 4096) stderrChunks = stderrChunks.slice(-4096);
        });

        child.on('message', (msg: any) => {
          if (msg.type === 'progress') {
            jobManager.updateJob(job.id, {
              status: 'analyzing',
              progress: { phase: msg.phase, percent: msg.percent, message: msg.message },
            });
          } else if (msg.type === 'complete') {
            releaseRepoLock(analyzeLockKey);
            backend
              .init()
              .then(async () => {
                jobManager.updateJob(job.id, {
                  status: 'complete',
                  repoName: msg.result.repoName,
                });
                if (catalogEntryId && targetPath) {
                  try {
                    const meta = await loadMeta(getStoragePath(targetPath));
                    await markCatalogIndexed(
                      catalogEntryId,
                      msg.result.repoName,
                      meta?.lastCommit,
                    );
                    void startCodeDocJob({
                      registryName: msg.result.repoName,
                      repoPath: targetPath,
                      catalogEntryId,
                    }).catch((docErr) => {
                      logger.warn({ err: docErr, catalogEntryId }, 'Failed to start code-doc job');
                    });
                  } catch (err) {
                    logger.warn({ err, catalogEntryId }, 'Failed to update catalog after analyze');
                  }
                }
              })
              .catch((err) => {
                logger.error({ err }, 'backend.init() failed after analyze:');
                jobManager.updateJob(job.id, {
                  status: 'failed',
                  error: 'Server failed to reload after analysis. Try again.',
                });
              });
          } else if (msg.type === 'error') {
            releaseRepoLock(analyzeLockKey);
            jobManager.updateJob(job.id, {
              status: 'failed',
              error: msg.message,
            });
          }
        });

        child.on('error', (err) => {
          releaseRepoLock(analyzeLockKey);
          jobManager.updateJob(job.id, {
            status: 'failed',
            error: `Worker process error: ${err.message}`,
          });
        });

        child.on('exit', (code) => {
          const j = jobManager.getJob(job.id);
          if (!j || j.status === 'complete' || j.status === 'failed') return;

          if (j.retryCount < MAX_WORKER_RETRIES) {
            j.retryCount++;
            const delay = 1000 * Math.pow(2, j.retryCount - 1);
            jobManager.updateJob(job.id, {
              status: 'analyzing',
              progress: {
                phase: 'retrying',
                percent: j.progress.percent,
                message: `Worker crashed, retrying (${j.retryCount}/${MAX_WORKER_RETRIES})...`,
              },
            });
            stderrChunks = '';
            setTimeout(forkWorker, delay);
          } else {
            releaseRepoLock(analyzeLockKey);
            jobManager.updateJob(job.id, {
              status: 'failed',
              error: `Worker crashed ${MAX_WORKER_RETRIES + 1} times (code ${code})${stderrChunks ? ': ' + stderrChunks.trim().split('\n').pop() : ''}`,
            });
          }
        });

        jobManager.registerChild(job.id, child);

        child.send({
          type: 'start',
          repoPath: targetPath,
          options: {
            force: !!params.force,
            embeddings: !!params.embeddings,
            dropEmbeddings: !!params.dropEmbeddings,
            registryName: params.registryName,
            skipGit: false,
            skipAgentsMd: true,
            skipSkills: true,
          },
        });
      };

      forkWorker();
    } catch (err: any) {
      if (targetPath) releaseRepoLock(getStoragePath(targetPath));
      jobManager.updateJob(job.id, {
        status: 'failed',
        error: err.message || 'Analysis failed',
      });
    }
  })();

  return { jobId: job.id, status: 'cloning' };
};
