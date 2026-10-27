import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { withKernelFileLock } from './kernel-file-lock.js';
import { writeAtomicJson } from './atomic-json.js';

const VERSION = '0.1.0';
const NONCE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

// Single-host replay ledger. All workers sharing a signing key must use the
// same store; the retained marker prevents silent reset after state loss.
export class FileRemoteNonceStore {
  constructor({ filePath, clock = () => Date.now(), maxNonces = 10_000, lockTimeoutMs = 5_000 } = {}) {
    if (process.platform !== 'linux') throw new Error('FileRemoteNonceStore requires Linux flock');
    if (typeof filePath !== 'string' || !filePath.trim() || typeof clock !== 'function' ||
        !Number.isSafeInteger(maxNonces) || maxNonces < 1 || maxNonces > 1_000_000 ||
        !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError('Invalid nonce store configuration');
    Object.assign(this, { filePath: path.resolve(filePath), clock, maxNonces, lockTimeoutMs });
  }

  async consume(nonce, expiresAt) {
    if (typeof nonce !== 'string' || !NONCE.test(nonce) || !Number.isSafeInteger(expiresAt)) throw new TypeError('Invalid nonce or expiry');
    await mkdir(path.dirname(this.filePath), { recursive: true });
    return withKernelFileLock(`${this.filePath}.flock`, this.lockTimeoutMs, async () => {
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid nonce store clock');
      if (expiresAt < now) throw fault('REMOTE_AUTH_EXPIRED');
      const marker = `${this.filePath}.initialized`;
      let initialized = false;
      try { const handle = await open(marker, 'r'); await handle.close(); initialized = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let state;
      try {
        const handle = await open(this.filePath, 'r');
        try {
          if ((await handle.stat()).size > this.maxNonces * 96 + 1024) throw new Error('Nonce state exceeds capacity');
          state = JSON.parse(await handle.readFile('utf8'));
        } finally { await handle.close(); }
      } catch (error) {
        if (error.code !== 'ENOENT' || initialized) throw error;
        state = { schemaVersion: VERSION, maxNonces: this.maxNonces, nonces: {} };
      }
      if (state?.schemaVersion !== VERSION || state.maxNonces !== this.maxNonces ||
          !state.nonces || typeof state.nonces !== 'object' || Array.isArray(state.nonces) ||
          Object.keys(state.nonces).length > this.maxNonces) throw new Error('Invalid nonce state');
      const hash = createHash('sha256').update(nonce).digest('hex');
      for (const [id, expiry] of Object.entries(state.nonces)) {
        if (!HASH.test(id) || !Number.isSafeInteger(expiry) || expiry < 0) throw new Error('Invalid nonce entry');
        if (expiry < now) delete state.nonces[id];
      }
      if (Object.hasOwn(state.nonces, hash)) throw fault('REMOTE_AUTH_REPLAY');
      if (Object.keys(state.nonces).length >= this.maxNonces) throw fault('REMOTE_AUTH_CAPACITY');
      state.nonces[hash] = expiresAt;
      if (!initialized) { const handle = await open(marker, 'wx', 0o600); try { await handle.sync(); } finally { await handle.close(); } }
      await writeAtomicJson(this.filePath, state, { space: 0 });
    });
  }
}

function fault(code) { return Object.assign(new Error(code), { code }); }
