import { appendFile, mkdir, readFile, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SCHEMA_VERSION = '0.2.0';

// Reconciled from the existing runtime durability branch. Never steal a live lock.
export class DurableIdempotencyStore {
  #records = new Map();
  #lockPath;
  constructor({ filePath, clock = () => Date.now(), ttlMs = 300_000, maxRecords = 10_000, lockRetryMs = 10, lockTimeoutMs = 5_000 } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath must be a non-empty string');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    for (const [name, value] of Object.entries({ ttlMs, maxRecords, lockRetryMs, lockTimeoutMs })) if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    Object.assign(this, { filePath, clock, ttlMs, maxRecords, lockRetryMs, lockTimeoutMs });
    this.#lockPath = `${filePath}.lock`;
    this.ready = false;
  }
  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.#withLock(() => this.#reload());
    this.ready = true;
    return this;
  }
  async get(key) {
    this.#assertReady(); key = normalizeKey(key);
    return this.#withLock(async () => { await this.#reload(); return clone(this.#records.get(key) ?? null); });
  }
  async claim(key, fingerprint, { expiresAt = this.clock() + this.ttlMs } = {}) {
    this.#assertReady(); key = normalizeKey(key);
    if (typeof fingerprint !== 'string' || !fingerprint) throw new TypeError('fingerprint must be a non-empty string');
    this.#validateExpiry(expiresAt);
    return this.#withLock(async () => {
      await this.#reload(); this.#validateExpiry(expiresAt);
      const existing = this.#records.get(key);
      if (existing) return clone({ state: existing.fingerprint !== fingerprint ? 'conflict' : existing.status === 'completed' ? 'replay' : 'in_progress', record: existing });
      this.#checkCapacity(key);
      const record = { schemaVersion: SCHEMA_VERSION, key, status: 'pending', fingerprint, claimToken: randomUUID(), response: null, createdAt: this.clock(), expiresAt };
      await this.#putRecord(record);
      return clone({ state: 'claimed', record });
    });
  }
  async completeClaim(key, fingerprint, claimToken, response, { expiresAt = this.clock() + this.ttlMs } = {}) {
    this.#assertReady(); key = normalizeKey(key); this.#validateExpiry(expiresAt);
    return this.#withLock(async () => {
      await this.#reload(); this.#validateExpiry(expiresAt);
      const existing = this.#records.get(key);
      if (!existing || existing.status !== 'pending' || existing.fingerprint !== fingerprint || !claimToken || existing.claimToken !== claimToken) return false;
      await this.#putRecord({ ...existing, status: 'completed', response: clone(response ?? null), expiresAt });
      return true;
    });
  }
  async put(key, value, { expiresAt = this.clock() + this.ttlMs } = {}) {
    this.#assertReady(); key = normalizeKey(key); this.#validateExpiry(expiresAt);
    if (!value || typeof value !== 'object') throw new TypeError('value must be an object');
    value = clone(value);
    return this.#withLock(async () => {
      await this.#reload(); this.#validateExpiry(expiresAt); this.#checkCapacity(key);
      if (this.#records.get(key)?.status === 'pending') throw Object.assign(new Error('Pending claims require completeClaim()'), { code: 'IDEMPOTENCY_CLAIM_REQUIRED' });
      const record = { schemaVersion: SCHEMA_VERSION, key, value, status: 'completed', fingerprint: value.fingerprint ?? null, response: value.response ?? null, createdAt: this.clock(), expiresAt };
      await this.#putRecord(record); return clone(record);
    });
  }
  async delete(key) {
    this.#assertReady(); key = normalizeKey(key);
    return this.#withLock(async () => { await this.#reload(); if (!this.#records.has(key)) return false; await this.#append({ schemaVersion: SCHEMA_VERSION, op: 'delete', key }); this.#records.delete(key); return true; });
  }
  async compact() {
    this.#assertReady();
    return this.#withLock(async () => {
      await this.#reload();
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile([...this.#records.values()].map((record) => JSON.stringify(journalEntry(record))).join('\n') + '\n');
        await handle.sync(); await handle.close(); handle = null;
        await rename(temporary, this.filePath);
      } finally { await handle?.close(); await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      return this.snapshot();
    });
  }
  snapshot() { this.#assertReady(); return { schemaVersion: SCHEMA_VERSION, type: 'durable-idempotency-store', retainedRecords: this.#records.size, ttlMs: this.ttlMs, maxRecords: this.maxRecords }; }
  async #putRecord(record) { await this.#append(journalEntry(record)); this.#records.set(record.key, clone(record)); }
  async #append(record) {
    await appendFile(this.filePath, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    const handle = await open(this.filePath, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  }
  async #reload() {
    let text;
    try { text = await readFile(this.filePath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') text = ''; else throw error; }
    const records = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (item?.schemaVersion !== SCHEMA_VERSION || !['put', 'delete'].includes(item.op)) throw new Error('Invalid idempotency journal record');
      const key = normalizeKey(item.key);
      if (item.op === 'delete') { records.delete(key); continue; }
      if (!item.value || typeof item.value !== 'object' || !Number.isFinite(item.expiresAt)) throw new Error('Invalid idempotency record');
      const status = item.value.status ?? 'completed';
      if (!['pending', 'completed'].includes(status)) throw new Error('Invalid idempotency status');
      records.set(key, { ...item.value, schemaVersion: SCHEMA_VERSION, key, status, createdAt: item.createdAt, expiresAt: item.expiresAt });
    }
    for (const [key, record] of records) if (record.expiresAt <= this.clock()) records.delete(key);
    this.#records = records;
  }
  async #withLock(operation) {
    const deadline = performance.now() + this.lockTimeoutMs;
    for (;;) {
      try { await mkdir(this.#lockPath); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (performance.now() >= deadline) throw Object.assign(new Error('Timed out acquiring idempotency store lock'), { code: 'IDEMPOTENCY_LOCK_TIMEOUT' });
        await new Promise((resolve) => setTimeout(resolve, this.lockRetryMs));
      }
    }
    try { return await operation(); } finally { await rm(this.#lockPath, { recursive: true }); }
  }
  #checkCapacity(key) { if (!this.#records.has(key) && this.#records.size >= this.maxRecords) throw Object.assign(new Error('Idempotency capacity exhausted'), { code: 'IDEMPOTENCY_CAPACITY' }); }
  #validateExpiry(value) { if (!Number.isFinite(value) || value <= this.clock()) throw new TypeError('expiresAt must be a future timestamp'); }
  #assertReady() { if (!this.ready) throw new Error('DurableIdempotencyStore.init() must be awaited before use'); }
}
function journalEntry(record) { const { key, createdAt, expiresAt, ...value } = record; return { schemaVersion: SCHEMA_VERSION, op: 'put', key, value, createdAt, expiresAt }; }
function normalizeKey(key) { if (typeof key !== 'string' || !key.trim() || key.length > 4096) throw new TypeError('key must be a non-empty string of at most 4096 characters'); return key; }
function clone(value) { return structuredClone(value); }
export { SCHEMA_VERSION as DURABLE_IDEMPOTENCY_SCHEMA_VERSION };
