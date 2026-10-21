import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// flock locks the open file description inherited by fd 3. The parent keeps
// that description alive throughout the callback, including after flock exits.
export async function withKernelFileLock(filePath, timeoutMs, operation) {
  if (process.platform !== 'linux') throw new Error('Linux flock is required');
  const handle = await open(filePath, 'a+', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('flock', ['-x', '-w', String(timeoutMs / 1000), '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else if (code === 1) reject(Object.assign(new Error('Timed out acquiring file lock'), { code: 'FILE_LOCK_TIMEOUT' }));
        else reject(Object.assign(new Error(`File lock failed (${signal ?? code})`), { code: 'FILE_LOCK_ERROR' }));
      });
    });
    return await operation();
  } finally { await handle.close(); }
}
