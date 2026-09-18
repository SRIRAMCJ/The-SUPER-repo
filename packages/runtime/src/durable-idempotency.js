import { appendFile, mkdir, readFile, rename, writeFile, open, stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const SCHEMA_VERSION = '0.2.0';

export class DurableIdempotencyStore {
  #records = new Map();
  #lockPath;

  constructor({ filePath, clock = () => Date.now(), ttlMs = 300_000, maxRecords = 10_000 } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath must be a non-empty string');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive integer');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    for (const [name, value] of [['lockRetryMs', lockRetryMs], ['lockTimeoutMs', lockTimeoutMs], ['lockStaleMs', lockStaleMs]]) if (!Number.isInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer');
    this.filePath = filePath;
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.maxRecords = maxRecords;
    this.lockRetryMs = lockRetryMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockStaleMs = lockStaleMs;
    this.#lockPath = this.filePath + '.lock';
    this.ready = false;
  }

  async init() {
    if (this.ready) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    let text = '';
    try { text = await readFile(this.filePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw normalizeError(error, 'IDEMPOTENCY_REPLAY_FAILED'); }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch (error) { throw normalizeError(error, 'IDEMPOTENCY_REPLAY_FAILED'); }
      this.#apply(record);
    }
    this.#purge();
    this.ready = true;
    return this;
  }

  async get(key) {
    this.#assertReady();
    this.#purge();
    const record = this.#records.get(normalizeKey(key));
    return record ? clone(record) : null;
  }

  async claim(key, fingerprint, { expiresAt = this.clock() + this.ttlMs } = {}) {
    this.#assertReady();
    const normalizedKey = normalizeKey(key);
    if (typeof fingerprint !== 'string' || !fingerprint) throw new TypeError('fingerprint must be a non-empty string');
    if (!Number.isFinite(expiresAt) || expiresAt <= this.clock()) throw new TypeError('expiresAt must be a future timestamp');
    return this.#withLock(async () => {
      await this.#reload();
      this.#purge();
      const existing = this.#records.get(normalizedKey);
      if (existing && existing.expiresAt > this.clock()) {
        if (existing.fingerprint !== fingerprint) return freeze({ state: 'conflict', record: existing });
        if (existing.status === 'completed') return freeze({ state: 'replay', record: existing });
        return freeze({ state: 'in_progress', record: existing });
      }
      const record = freeze({ schemaVersion: SCHEMA_VERSION, key: normalizedKey, status: 'pending', fingerprint, response: null, createdAt: this.clock(), expiresAt });
      await this.#append({ schemaVersion: SCHEMA_VERSION, op: 'put', ...record });
      this.#records.set(normalizedKey, record);
      this.#enforceBound();
      return freeze({ state: 'claimed', record });
    });
  }

  async put(key, value, { expiresAt = this.clock() + this.ttlMs } = {}) {
    this.#assertReady();
    const normalizedKey = normalizeKey(key);
    if (!value || typeof value !== 'object') throw new TypeError('value must be an object');
    if (!Number.isFinite(expiresAt) || expiresAt <= this.clock()) throw new TypeError('expiresAt must be a future timestamp');
    const record = freeze({ schemaVersion: SCHEMA_VERSION, key: normalizedKey, value, createdAt: this.clock(), expiresAt });
    await this.#withLock(async () => {
      await this.#reload();
      await this.#append({ schemaVersion: SCHEMA_VERSION, op: 'put', ...record });
      this.#records.set(normalizedKey, record);
    });
    this.#enforceBound();
    return clone(record);
  }

  async delete(key) {
    this.#assertReady();
    const normalizedKey = normalizeKey(key);
    return this.#withLock(async () => {
      await this.#reload();
      if (!this.#records.has(normalizedKey)) return false;
      await this.#append({ schemaVersion: SCHEMA_VERSION, op: 'delete', key: normalizedKey });
      this.#records.delete(normalizedKey);
      return true;
    });
  }

  async compact() {
    this.#assertReady();
    this.#purge();
    const tmp = this.filePath + '.tmp';
    const text = [...this.#records.values()].map((record) => JSON.stringify({ schemaVersion: SCHEMA_VERSION, op: 'put', ...record })).join('\n') + (this.#records.size ? '\n' : '');
    await writeFile(tmp, text, 'utf8');
    const handle = await open(tmp, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, this.filePath);
    return this.snapshot();
  }

  snapshot() {
    this.#assertReady();
    this.#purge();
    return freeze({ schemaVersion: SCHEMA_VERSION, type: 'durable-idempotency-store', retainedRecords: this.#records.size, ttlMs: this.ttlMs, maxRecords: this.maxRecords });
  }

  #apply(record) {
    if (!record || record.schemaVersion !== SCHEMA_VERSION || !['put', 'delete'].includes(record.op)) throw new Error('Invalid idempotency journal record');
    const key = normalizeKey(record.key);
    if (record.op === 'delete') this.#records.delete(key);
    else {
      if (!record.value || typeof record.value !== 'object' || !Number.isFinite(record.expiresAt)) throw new Error('Invalid idempotency record');
      this.#records.set(key, freeze({ schemaVersion: SCHEMA_VERSION, key, value: record.value, status: record.value.status ?? 'completed', fingerprint: record.value.fingerprint ?? null, response: record.value.response ?? null, createdAt: record.createdAt, expiresAt: record.expiresAt }));
    }
    this.#enforceBound();
  }

  async #append(record) {
    await appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf8');
    const handle = await open(this.filePath, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  #purge() {
    const now = this.clock();
    for (const [key, record] of this.#records) if (record.expiresAt <= now) this.#records.delete(key);
  }

  #enforceBound() {
    while (this.#records.size > this.maxRecords) this.#records.delete(this.#records.keys().next().value);
  }


  async #reload() {
    this.#records.clear();
    let text = '';
    try { text = await readFile(this.filePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw normalizeError(error, 'IDEMPOTENCY_REPLAY_FAILED'); }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch (error) { throw normalizeError(error, 'IDEMPOTENCY_REPLAY_FAILED'); }
      this.#apply(record);
    }
  }

  async #withLock(operation) {
    const deadline = this.clock() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(this.#lockPath);
        try { return await operation(); } finally { await rm(this.#lockPath, { recursive: true, force: true }); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stale = false;
        try { stale = this.clock() - (await stat(this.#lockPath)).mtimeMs >= this.lockStaleMs; } catch {}
        if (stale) { await rm(this.#lockPath, { recursive: true, force: true }); continue; }
        if (this.clock() >= deadline) {
          const timeout = new Error('Timed out acquiring idempotency store lock');
          timeout.code = 'IDEMPOTENCY_LOCK_TIMEOUT';
          throw timeout;
        }
        await new Promise((resolve) => setTimeout(resolve, this.lockRetryMs));
      }
    }
  }

  #assertReady() { if (!this.ready) throw new Error('DurableIdempotencyStore.init() must be awaited before use'); }
}

function normalizeKey(key) {
  const value = String(key ?? '').trim();
  if (!value) throw new TypeError('key must be non-empty');
  return value.slice(0, 512);
}
function clone(value) { return structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function normalizeError(error, code) { const normalized = new Error(error instanceof Error ? error.message : String(error)); normalized.code = code; return normalized; }
export { SCHEMA_VERSION as DURABLE_IDEMPOTENCY_SCHEMA_VERSION };
