import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { withKernelFileLock } from './kernel-file-lock.js';
import { writeAtomicJson } from './atomic-json.js';

const SCHEMA_VERSION = '0.1.0';

export class FileRateLimiter {
  #observed = false;
  #retained = 0;

  constructor({ filePath, clock = () => Date.now(), maxRequests = 60, windowMs = 60_000, maxPrincipals = 10_000, lockTimeoutMs = 5_000 } = {}) {
    if (process.platform !== 'linux') throw new Error('FileRateLimiter requires Linux flock');
    if (typeof filePath !== 'string' || !filePath.trim() || typeof clock !== 'function') throw new TypeError('filePath and clock are required');
    for (const [name, value] of Object.entries({ maxRequests, windowMs, maxPrincipals, lockTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    Object.assign(this, { filePath: path.resolve(filePath), clock, maxRequests, windowMs, maxPrincipals, lockTimeoutMs });
  }

  async consume(principal) {
    if (typeof principal !== 'string' || !principal.trim() || principal.length > 256) throw new TypeError('principal must be a non-empty string of at most 256 characters');
    const key = createHash('sha256').update(principal).digest('hex');
    await mkdir(path.dirname(this.filePath), { recursive: true });
    return withKernelFileLock(`${this.filePath}.flock`, this.lockTimeoutMs, async () => {
      const now = this.clock();
      if (!Number.isFinite(now)) throw new TypeError('clock must return a finite timestamp');
      const state = await this.#read();
      let dirty = false;
      for (const [id, window] of Object.entries(state.windows)) {
        if (now - window.startedAt >= this.windowMs) { delete state.windows[id]; dirty = true; }
      }
      const window = state.windows[key];
      let result;
      if (window?.count >= this.maxRequests) result = { allowed: false, retryAfterMs: Math.max(1, Math.ceil(this.windowMs - (now - window.startedAt))) };
      else {
        if (!window && Object.keys(state.windows).length >= this.maxPrincipals) throw Object.assign(new Error('Rate limiter capacity exhausted'), { code: 'RATE_LIMIT_CAPACITY' });
        state.windows[key] = window ? { startedAt: window.startedAt, count: window.count + 1 } : { startedAt: now, count: 1 };
        dirty = true;
        result = { allowed: true, retryAfterMs: 0 };
      }
      if (dirty) { await writeAtomicJson(this.filePath, state); this.#observed = true; }
      this.#retained = Object.keys(state.windows).length;
      return result;
    });
  }

  snapshot() { return { schemaVersion: SCHEMA_VERSION, type: 'file-rate-limiter', maxRequests: this.maxRequests, windowMs: this.windowMs, maxPrincipals: this.maxPrincipals, retainedPrincipals: this.#retained }; }

  async #read() {
    let data;
    try {
      const handle = await open(this.filePath, 'r');
      try {
        if ((await handle.stat()).size > this.maxPrincipals * 256 + 1024) throw new Error('Rate limiter state exceeds configured capacity');
        data = await handle.readFile('utf8');
        this.#observed = true;
      } finally { await handle.close(); }
    }
    catch (error) {
      if (error.code !== 'ENOENT' || this.#observed) throw error;
      return this.#empty();
    }
    const state = JSON.parse(data);
    if (state?.schemaVersion !== SCHEMA_VERSION || state.maxRequests !== this.maxRequests || state.windowMs !== this.windowMs ||
      !state.windows || typeof state.windows !== 'object' || Array.isArray(state.windows) || Object.keys(state.windows).length > this.maxPrincipals) throw new Error('Invalid rate limiter state');
    for (const [key, window] of Object.entries(state.windows)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !window || !Number.isFinite(window.startedAt) || !Number.isSafeInteger(window.count) || window.count < 1 || window.count > this.maxRequests) throw new Error('Invalid rate limiter window');
    }
    return state;
  }

  #empty() { return { schemaVersion: SCHEMA_VERSION, maxRequests: this.maxRequests, windowMs: this.windowMs, windows: {} }; }
}

export { SCHEMA_VERSION as FILE_RATE_LIMITER_SCHEMA_VERSION };
