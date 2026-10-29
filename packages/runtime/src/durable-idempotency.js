import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withKernelFileLock } from './kernel-file-lock.js';

const SCHEMA_VERSION = '0.2.0';

// flock locks the open file description shared with the short-lived child.
// The parent retains that descriptor during the transaction; its death releases
// the kernel lock without leaving a directory that needs to be stolen.
export class DurableIdempotencyStore {
  #records = new Map();
  #lockPath;
  #observed = false;
  constructor({ filePath, clock = () => Date.now(), ttlMs = 300_000, maxRecords = 10_000, lockRetryMs = 10, lockTimeoutMs = 5_000 } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath must be a non-empty string');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    for (const [name, value] of Object.entries({ ttlMs, maxRecords, lockRetryMs, lockTimeoutMs })) if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    Object.assign(this, { filePath, clock, ttlMs, maxRecords, lockRetryMs, lockTimeoutMs });
    if (process.platform !== 'linux') throw new Error('DurableIdempotencyStore requires Linux flock');
    this.#lockPath = `${filePath}.flock`;
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
      if (existing) return clone({ state: existing.fingerprint !== fingerprint ? 'conflict' : existing.status === 'completed' ? 'replay' : existing.expiresAt <= this.clock() ? 'recovery_required' : 'in_progress', record: existing });
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
      if (!existing || existing.status !== 'pending' || existing.expiresAt <= this.clock() || existing.fingerprint !== fingerprint || !claimToken || existing.claimToken !== claimToken) return false;
      await this.#putRecord({ ...existing, status: 'completed', response: clone(response ?? null), expiresAt });
      return true;
    });
  }
  async reconcileClaim(key, fingerprint, claimToken, response, { reason, expiresAt = this.clock() + this.ttlMs } = {}) {
    this.#assertReady(); key = normalizeKey(key); this.#validateExpiry(expiresAt);
    validateReason(reason);
    return this.#withLock(async () => {
      await this.#reload(); this.#validateExpiry(expiresAt);
      const existing = this.#records.get(key);
      if (!existing || existing.status !== 'pending' || existing.expiresAt > this.clock() || existing.fingerprint !== fingerprint || !claimToken || existing.claimToken !== claimToken) return false;
      await this.#putRecord({ ...existing, status: 'completed', response: clone(response ?? null), expiresAt, reconciliation: { reason: reason.trim(), at: this.clock() } });
      return true;
    });
  }
  async releaseClaim(key, fingerprint, claimToken, reason) {
    this.#assertReady(); key = normalizeKey(key);
    validateReason(reason);
    return this.#withLock(async () => {
      await this.#reload();
      const existing = this.#records.get(key);
      if (!existing || existing.status !== 'pending' || existing.expiresAt > this.clock() || existing.fingerprint !== fingerprint || !claimToken || existing.claimToken !== claimToken) return false;
      await this.#append({ schemaVersion: SCHEMA_VERSION, op: 'delete', key, reason: reason.trim(), reconciledAt: this.clock() });
      this.#records.delete(key);
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
    return this.#withLock(async () => { await this.#reload(); if (!this.#records.has(key)) return false; if (this.#records.get(key).status === 'pending') throw Object.assign(new Error('Pending claims require reconciliation'), { code: 'IDEMPOTENCY_CLAIM_REQUIRED' }); await this.#append({ schemaVersion: SCHEMA_VERSION, op: 'delete', key }); this.#records.delete(key); return true; });
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
    await this.#markInitialized();
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record) + '\n', 'utf8');
      await handle.sync();
      this.#observed = true;
    } finally { await handle.close(); }
  }
  async #reload() {
    let initialized = false;
    try {
      const marker = JSON.parse(await readFile(`${this.filePath}.initialized`, 'utf8'));
      if (marker?.schemaVersion !== SCHEMA_VERSION || marker.initialized !== true) throw new Error('Invalid idempotency initialization marker');
      initialized = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let text;
    try { text = await readFile(this.filePath, 'utf8'); this.#observed = true; }
    catch (error) { if (error.code === 'ENOENT' && !this.#observed && !initialized) text = ''; else throw error; }
    if (text && !initialized) await this.#markInitialized();
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
    for (const [key, record] of records) if (record.expiresAt <= this.clock() && record.status === 'completed') records.delete(key);
    this.#records = records;
  }
  async #withLock(operation) {
    try { return await withKernelFileLock(this.#lockPath, this.lockTimeoutMs, operation); }
    catch (error) {
      if (error.code === 'FILE_LOCK_TIMEOUT') error.code = 'IDEMPOTENCY_LOCK_TIMEOUT';
      if (error.code === 'FILE_LOCK_ERROR') error.code = 'IDEMPOTENCY_LOCK_ERROR';
      throw error;
    }
  }
  #checkCapacity(key) { if (!this.#records.has(key) && this.#records.size >= this.maxRecords) throw Object.assign(new Error('Idempotency capacity exhausted'), { code: 'IDEMPOTENCY_CAPACITY' }); }
  #validateExpiry(value) { if (!Number.isFinite(value) || value <= this.clock()) throw new TypeError('expiresAt must be a future timestamp'); }
  #assertReady() { if (!this.ready) throw new Error('DurableIdempotencyStore.init() must be awaited before use'); }
  async #markInitialized() {
    const markerPath = `${this.filePath}.initialized`;
    let handle;
    try {
      handle = await open(markerPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ schemaVersion: SCHEMA_VERSION, initialized: true }));
      await handle.sync();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await handle?.close(); }
  }
}
function journalEntry(record) { const { key, createdAt, expiresAt, ...value } = record; return { schemaVersion: SCHEMA_VERSION, op: 'put', key, value, createdAt, expiresAt }; }
function normalizeKey(key) { if (typeof key !== 'string' || !key.trim() || key.length > 4096) throw new TypeError('key must be a non-empty string of at most 4096 characters'); return key; }
function validateReason(reason) { if (typeof reason !== 'string' || !reason.trim() || reason.length > 1024) throw new TypeError('A reconciliation reason of at most 1024 characters is required'); }
function clone(value) { return structuredClone(value); }
export { SCHEMA_VERSION as DURABLE_IDEMPOTENCY_SCHEMA_VERSION };
