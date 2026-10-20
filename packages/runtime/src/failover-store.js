import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Linux flock serializes read/modify/write across processes. The lock is
// released by the OS on process death; epochs fence stale lease holders.
export class FileFailoverStore {
  #observed = false;

  constructor(filePath, { lockTimeoutSeconds = 5 } = {}) {
    if (process.platform !== 'linux') throw new Error('FileFailoverStore requires Linux flock');
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
    if (!Number.isSafeInteger(lockTimeoutSeconds) || lockTimeoutSeconds < 1) throw new TypeError('lockTimeoutSeconds must be positive');
    this.filePath = path.resolve(filePath);
    this.lockTimeoutSeconds = lockTimeoutSeconds;
  }

  claim(name, owner, leaseMs = 30_000) { return this.#call({ action: 'claim', name, owner, leaseMs }); }
  renew(name, lease, leaseMs = 30_000) { return this.#call({ action: 'renew', name, ...credentials(lease), leaseMs }); }
  commit(name, lease, result) { return this.#call({ action: 'commit', name, ...credentials(lease), result }); }
  release(name, lease) { return this.#call({ action: 'release', name, ...credentials(lease) }); }
  inspect(name) { return this.#call({ action: 'inspect', name }); }

  async #call(request) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const response = await invoke(this.filePath, this.lockTimeoutSeconds, { ...request, observed: this.#observed });
    if (response.observed) this.#observed = true;
    if (!response.ok) throw Object.assign(new Error(response.code), { code: response.code, retryable: ['FAILOVER_LEASE_HELD', 'FAILOVER_LOCK_TIMEOUT'].includes(response.code) });
    return response.record;
  }
}

function credentials(lease) {
  if (!lease || typeof lease.token !== 'string' || !Number.isSafeInteger(lease.epoch)) throw new TypeError('lease requires token and epoch');
  return { token: lease.token, epoch: lease.epoch };
}

function invoke(filePath, seconds, request) {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-x', '-w', String(seconds), `${filePath}.lock`, process.execPath, fileURLToPath(new URL('./failover-store-worker.js', import.meta.url)), filePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errorOutput = '';
    child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 1_000_000) child.kill(); });
    child.stderr.on('data', (chunk) => { errorOutput += chunk; if (errorOutput.length > 4096) child.kill(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 1 && !output) { reject(Object.assign(new Error('Failover lock timeout'), { code: 'FAILOVER_LOCK_TIMEOUT' })); return; }
      if (code !== 0) { reject(Object.assign(new Error('Failover helper failed'), { code: 'FAILOVER_STORE_ERROR' })); return; }
      try { resolve(JSON.parse(output)); } catch { reject(Object.assign(new Error('Invalid failover response'), { code: 'FAILOVER_STORE_ERROR' })); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
