import { mkdir, rm, stat, appendFile, readFile, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const SCHEMA_VERSION = '0.1.0';
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_MS = 10;

export const DISTRIBUTED_COORDINATION_SCHEMA_VERSION = SCHEMA_VERSION;
export const DISTRIBUTED_COORDINATION_STATES = Object.freeze(['available', 'held', 'fenced', 'expired']);

export class DistributedCoordinationKernel {
  #records = new Map();
  #memoryTail = Promise.resolve();
  #lockPath;

  constructor({ filePath = null, clock = () => Date.now(), leaseMs = DEFAULT_LEASE_MS, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, retryMs = DEFAULT_RETRY_MS, staleLockMs = 30_000 } = {}) {
    for (const [name, value] of [['leaseMs', leaseMs], ['lockTimeoutMs', lockTimeoutMs], ['retryMs', retryMs], ['staleLockMs', staleLockMs]]) {
      if (!Number.isInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer');
    }
    if (filePath !== null && (typeof filePath !== 'string' || !filePath.trim())) throw new TypeError('filePath must be null or a non-empty string');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.filePath = filePath; this.clock = clock; this.leaseMs = leaseMs; this.lockTimeoutMs = lockTimeoutMs; this.retryMs = retryMs; this.staleLockMs = staleLockMs;
    this.#lockPath = filePath ? filePath + '.lock' : null; this.ready = filePath === null;
  }

  async init() {
    if (this.ready) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.#reload();
    this.ready = true;
    return this;
  }

  async acquire(resource, { ownerId, requestId = randomUUID(), leaseMs = this.leaseMs, metadata = null } = {}) {
    this.#assertReady(); const key = normalize(resource, 'resource'); ownerId = normalize(ownerId, 'ownerId'); requestId = normalize(requestId, 'requestId');
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be a positive integer');
    return this.#atomic(async () => {
      const now = this.clock(); this.#expire(now);
      const current = this.#records.get(key);
      if (current && current.status === 'held') {
        if (current.ownerId === ownerId && current.requestId === requestId) {
          const renewed = { ...current, expiresAt: now + leaseMs, updatedAt: now };
          await this.#append({ op: 'renew', record: renewed }); this.#records.set(key, freeze(renewed));
          return result('renewed', renewed);
        }
        return result('busy', current);
      }
      const record = { schemaVersion: SCHEMA_VERSION, resource: key, status: 'held', ownerId, requestId, fencingToken: (current?.fencingToken ?? 0) + 1, generation: (current?.generation ?? 0) + 1, acquiredAt: now, updatedAt: now, expiresAt: now + leaseMs, metadata };
      await this.#append({ op: 'acquire', record }); this.#records.set(key, freeze(record));
      return result('acquired', record);
    });
  }

  async renew(resource, { ownerId, requestId, fencingToken, leaseMs = this.leaseMs } = {}) {
    this.#assertReady(); const key = normalize(resource, 'resource'); ownerId = normalize(ownerId, 'ownerId'); requestId = normalize(requestId, 'requestId'); assertToken(fencingToken);
    return this.#atomic(async () => {
      const now = this.clock(); this.#expire(now); const current = this.#records.get(key);
      if (!current) return result('not_found');
      if (!matches(current, ownerId, requestId, fencingToken)) return result('fenced', current);
      const renewed = { ...current, expiresAt: now + leaseMs, updatedAt: now };
      await this.#append({ op: 'renew', record: renewed }); this.#records.set(key, freeze(renewed));
      return result('renewed', renewed);
    });
  }

  async release(resource, { ownerId, requestId, fencingToken } = {}) {
    this.#assertReady(); const key = normalize(resource, 'resource'); ownerId = normalize(ownerId, 'ownerId'); requestId = normalize(requestId, 'requestId'); assertToken(fencingToken);
    return this.#atomic(async () => {
      const current = this.#records.get(key);
      if (!current) return result('not_found');
      if (!matches(current, ownerId, requestId, fencingToken)) return result('fenced', current);
      const released = { ...current, status: 'available', updatedAt: this.clock(), expiresAt: this.clock() };
      await this.#append({ op: 'release', record: released }); this.#records.set(key, freeze(released));
      return result('released', released);
    });
  }

  async inspect(resource) {
    this.#assertReady(); const key = normalize(resource, 'resource');
    return this.#atomic(async () => { this.#expire(this.clock()); const r = this.#records.get(key); return r ? clone(r) : null; });
  }

  async forceFence(resource, { reason = 'administrative-fence' } = {}) {
    this.#assertReady(); const key = normalize(resource, 'resource');
    return this.#atomic(async () => {
      const current = this.#records.get(key); if (!current) return result('not_found');
      const fenced = { ...current, status: 'fenced', fencingToken: current.fencingToken + 1, updatedAt: this.clock(), fenceReason: String(reason) };
      await this.#append({ op: 'fence', record: fenced }); this.#records.set(key, freeze(fenced));
      return result('fenced', fenced);
    });
  }

  snapshot() {
    this.#assertReady(); const values = [...this.#records.values()];
    return freeze({ schemaVersion: SCHEMA_VERSION, type: 'distributed-coordination-kernel', resources: values.length, held: values.filter(r => r.status === 'held').length, fenced: values.filter(r => r.status === 'fenced').length });
  }

  async #atomic(operation) {
    if (!this.filePath) {
      const run = this.#memoryTail.then(operation, operation); this.#memoryTail = run.catch(() => {}); return run;
    }
    const deadline = this.clock() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(this.#lockPath);
        try { await this.#reload(); return await operation(); } finally { await rm(this.#lockPath, { recursive: true, force: true }); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stale = false; try { stale = this.clock() - (await stat(this.#lockPath)).mtimeMs >= this.staleLockMs; } catch {}
        if (stale) { await rm(this.#lockPath, { recursive: true, force: true }); continue; }
        if (this.clock() >= deadline) throw coordinationError('COORDINATION_LOCK_TIMEOUT', 'Timed out acquiring coordination lock', true);
        await new Promise(resolve => setTimeout(resolve, this.retryMs));
      }
    }
  }

  async #reload() {
    this.#records.clear(); let text = '';
    try { text = await readFile(this.filePath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw coordinationError('COORDINATION_REPLAY_FAILED', e.message, false); }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry; try { entry = JSON.parse(line); } catch (e) { throw coordinationError('COORDINATION_CORRUPT', e.message, false); }
      if (entry.schemaVersion !== SCHEMA_VERSION || !entry.record || !['acquire', 'renew', 'release', 'fence'].includes(entry.op)) throw coordinationError('COORDINATION_CORRUPT', 'Invalid coordination journal entry', false);
      this.#records.set(entry.record.resource, freeze(entry.record));
    }
  }

  async #append(entry) {
    if (!this.filePath) return;
    await appendFile(this.filePath, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...entry }) + '\n', 'utf8');
    const handle = await open(this.filePath, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  }

  #expire(now) {
    for (const [key, record] of this.#records) {
      if (record.status === 'held' && record.expiresAt <= now) this.#records.set(key, freeze({ ...record, status: 'expired', updatedAt: now }));
    }
  }

  #assertReady() { if (!this.ready) throw new Error('DistributedCoordinationKernel.init() must be awaited before use when filePath is configured'); }
}

export function coordinationFingerprint({ resource, ownerId, requestId, fencingToken }) {
  return createHash('sha256').update(canonicalize({ resource, ownerId, requestId, fencingToken })).digest('hex');
}

function matches(record, ownerId, requestId, fencingToken) {
  return record.status === 'held' && record.ownerId === ownerId && record.requestId === requestId && record.fencingToken === fencingToken && record.expiresAt > Date.now();
}
function normalize(v, name) { if (typeof v !== 'string' || !v.trim() || v.trim().length > 512) throw new TypeError(name + ' must be a non-empty string <=512 chars'); return v.trim(); }
function assertToken(v) { if (!Number.isInteger(v) || v < 1) throw new TypeError('fencingToken must be a positive integer'); }
function canonicalize(value) { if (value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new TypeError('coordination fingerprint input must be JSON-like'); if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'; return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'; }
function coordinationError(code, message, retryable) { return Object.assign(new Error(message), { code, retryable }); }
function clone(v) { return structuredClone(v); }
function freeze(v) { return deepFreeze(structuredClone(v)); }
function deepFreeze(v) { if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v; for (const c of Object.values(v)) deepFreeze(c); return Object.freeze(v); }
function result(state, record = null) { return freeze({ state, record }); }
