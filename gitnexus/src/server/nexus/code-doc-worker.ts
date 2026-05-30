/**
 * Code Doc Worker — Forked Child Process
 *
 * IPC Protocol:
 *   Parent -> Child: { type: 'start', registryName, repoPath, maxEntities? }
 *   Child -> Parent: { type: 'progress', phase, message }
 *   Child -> Parent: { type: 'complete' }
 *   Child -> Parent: { type: 'error', message }
 */

import { runCodeDocPipeline } from './code-doc-runner.js';

interface StartMessage {
  type: 'start';
  registryName: string;
  repoPath: string;
  maxEntities?: number;
}

type WorkerMessage =
  | { type: 'progress'; phase: string; message: string }
  | { type: 'complete' }
  | { type: 'error'; message: string };

function send(msg: WorkerMessage) {
  process.send?.(msg);
}

process.on('uncaughtException', (err) => {
  send({ type: 'error', message: err?.message || 'Uncaught exception in code-doc worker' });
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason: any) => {
  send({ type: 'error', message: reason?.message || 'Unhandled rejection in code-doc worker' });
  setTimeout(() => process.exit(1), 500);
});

let started = false;
process.on('message', async (msg: StartMessage) => {
  if (msg.type !== 'start' || started) return;
  started = true;

  try {
    send({ type: 'progress', phase: 'generating', message: 'Generating code documentation...' });
    await runCodeDocPipeline({
      registryName: msg.registryName,
      repoPath: msg.repoPath,
      maxEntities: msg.maxEntities,
    });
    send({ type: 'complete' });
  } catch (err: any) {
    send({ type: 'error', message: err?.message || 'Code doc pipeline failed' });
  } finally {
    setTimeout(() => process.exit(0), 100);
  }
});
