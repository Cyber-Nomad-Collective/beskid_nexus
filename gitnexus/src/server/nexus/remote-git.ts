import { spawn } from 'child_process';

/** Resolve remote HEAD for a git HTTPS URL (shallow check before analyze). */
export const getRemoteHead = (
  gitUrl: string,
  branch?: string,
): Promise<string | null> => {
  return new Promise((resolve) => {
    const ref = branch ? `refs/heads/${branch}` : 'HEAD';
    const child = spawn('git', ['ls-remote', gitUrl, ref], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const line = stdout.trim().split('\n')[0];
      const sha = line?.split(/\s+/)[0];
      resolve(sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null);
    });
    child.on('error', () => resolve(null));
  });
};
