import { appendFile, mkdir, readFile, open, stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCHEMA_VERSION = '0.1.0';
const DEFAULT_TTL_MS = 300_000;

export const DISTRIBUTED_EFFECT_LEDGER_SCHEMA_VERSION = SCHEMA_VERSION;
export const DISTRIBUTED_EFFECT_STATES = Object.freeze(['pending', 'committed', 'failed']);

export class DistributedEffectLedger {
  #records = new Map();
  #lockPath;
  #memoryTail = Promise.resolve();

  constructor({ filePath = null, clock = () => Date.now(), ttlMs = DEFAULT_TTL_MS, lockRetryMs = 10, lockTimeoutMs = 5000, lockStaleMs = 30000, maxRecords = 10000 } = {}) {
    if (filePath !== null && (typeof filePath !== 'string' || !filePath.trim())) throw new TypeError('filePath must be null or a non-empty string');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    for (const [n, v] of [['ttlMs', ttlMs], ['lockRetryMs', lockRetryMs], ['lockTimeoutMs', lockTimeoutMs], ['lockStaleMs', lockStaleMs], ['maxRecords', maxRecords]]) if (!Number.isInteger(v) || v < 1) throw new TypeError(n + ' must be a positive integer');
    this.filePath = filePath; this.clock = clock; this.ttlMs = ttlMs; this.lockRetryMs = lockRetryMs; this.lockTimeoutMs = lockTimeoutMs; this.lockStaleMs = lockStaleMs; this.maxRecords = maxRecords;
    this.#lockPath = filePath ? filePath + '.lock' : null; this.ready = filePath === null;
  }

  async init() {
    if (this.ready) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.#reload(); this.#purgeExpired(); this.ready = true; return this;
  }

  async claim(effectKey, fingerprint, { executionId = null, operation = null, workerId = null, capabilityFingerprint = null, expiresAt = this.clock() + this.ttlMs } = {}) {
    this.#assertReady();
    const key = normalizeKey(effectKey, 'effectKey'); assertFingerprint(fingerprint); validateFuture(expiresAt, this.clock());
    const scope = normalizeScope({ executionId, operation, workerId, capabilityFingerprint });
    return this.#atomic(async () => {
      const now = this.clock(); this.#purgeExpired(now);
      const existing = this.#records.get(key);
      if (existing && existing.expiresAt > now) {
        if (existing.fingerprint !== fingerprint || !sameScope(existing.scope, scope)) return freeze({ state: 'conflict', record: existing });
        if (existing.status === 'committed') return freeze({ state: 'replay', record: existing });
        if (existing.status === 'pending') return freeze({ state: 'in_progress', record: existing });
        if (!existing.retryable) return freeze({ state: 'failed', record: existing });
      }
      const record = { schemaVersion: SCHEMA_VERSION, effectKey: key, fingerprint, scope, status: 'pending', claimToken: randomUUID(), generation: (existing?.generation ?? 0) + 1, result: null, error: null, retryable: false, createdAt: now, updatedAt: now, expiresAt };
      await this.#append({ op: 'claim', record }); this.#records.set(key, freeze(record)); this.#enforceBound();
      return freeze({ state: 'claimed', record });
    });
  }

  async commit(effectKey, claimToken, result = null) { return this.#transition(effectKey, claimToken, 'committed', { result, error: null, retryable: false }); }

  async fail(effectKey, claimToken, error, { retryable = true } = {}) {
    if (typeof retryable !== 'boolean') throw new TypeError('retryable must be boolean');
    return this.#transition(effectKey, claimToken, 'failed', { result: null, error: normalizeError(error), retryable });
  }

  async recover(effectKey, { force = false } = {}) {
    this.#assertReady(); const key = normalizeKey(effectKey, 'effectKey');
    return this.#atomic(async () => {
      const current = this.#records.get(key);
      if (!current) return freeze({ state: 'not_found' });
      if (current.status !== 'pending') return freeze({ state: current.status, record: current });
      if (!force && current.expiresAt > this.clock()) return freeze({ state: 'in_progress', record: current });
      const recovered = { ...current, status: 'failed', claimToken: null, expiresAt: this.clock() + this.ttlMs, error: { code: 'EFFECT_CLAIM_EXPIRED', message: 'Effect claim expired before commit', retryable: true }, retryable: true, updatedAt: this.clock() };
      await this.#append({ op: 'recover', record: recovered }); this.#records.set(key, freeze(recovered));
      return freeze({ state: 'recovered', record: recovered });
    });
  }

  async get(effectKey) {
    this.#assertReady(); this.#purgeExpired();
    const record = this.#records.get(normalizeKey(effectKey, 'effectKey')); return record ? clone(record) : null;
  }

  async execute(effectKey, fingerprint, handler, options = {}) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    const claim = await this.claim(effectKey, fingerprint, options);
    if (claim.state === 'replay') return freeze({ state: 'replay', result: claim.record.result, record: claim.record });
    if (claim.state !== 'claimed') return claim;
    try {
      const result = await handler({ effectKey: claim.record.effectKey, claimToken: claim.record.claimToken, generation: claim.record.generation, scope: claim.record.scope });
      const committed = await this.commit(claim.record.effectKey, claim.record.claimToken, result);
      return freeze({ state: 'committed', result: committed.record.result, record: committed.record });
    } catch (error) {
      try {
        await this.fail(claim.record.effectKey, claim.record.claimToken, error, { retryable: options.retryable !== false });
      } catch (ledgerFailure) {
        error.ledgerFailure = ledgerFailure;
      }
      throw error;
    }
  }

  snapshot() {
    this.#assertReady(); const values = [...this.#records.values()];
    return freeze({ schemaVersion: SCHEMA_VERSION, type: 'distributed-effect-ledger', retainedRecords: values.length, pending: values.filter(r => r.status === 'pending').length, committed: values.filter(r => r.status === 'committed').length, failed: values.filter(r => r.status === 'failed').length });
  }

  async #transition(effectKey, claimToken, status, patch) {
    this.#assertReady(); const key = normalizeKey(effectKey, 'effectKey');
    if (typeof claimToken !== 'string' || !claimToken) throw new TypeError('claimToken must be a non-empty string');
    return this.#atomic(async () => {
      const current = this.#records.get(key);
      if (!current) throw ledgerError('EFFECT_NOT_FOUND', 'Effect record not found', false);
      if (current.status !== 'pending') throw ledgerError('EFFECT_NOT_PENDING', 'Effect is no longer pending', false);
      if (current.claimToken !== claimToken) throw ledgerError('STALE_EFFECT_CLAIM', 'Effect claim token is stale or fenced', true);
      const next = freeze({ ...current, ...patch, status, claimToken: null, updatedAt: this.clock() });
      await this.#append({ op: status, record: next }); this.#records.set(key, next);
      return freeze({ state: status, record: next });
    });
  }

  async #atomic(operation) {
    if (!this.filePath) {
      const run = this.#memoryTail.then(operation, operation);
      this.#memoryTail = run.catch(() => {});
      return run;
    }
    const deadline = this.clock() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(this.#lockPath);
        try { await this.#reload(); return await operation(); } finally { await rm(this.#lockPath, { recursive: true, force: true }); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stale = false; try { stale = this.clock() - (await stat(this.#lockPath)).mtimeMs >= this.lockStaleMs; } catch {}
        if (stale) { await rm(this.#lockPath, { recursive: true, force: true }); continue; }
        if (this.clock() >= deadline) throw ledgerError('EFFECT_LEDGER_LOCK_TIMEOUT', 'Timed out acquiring effect ledger lock', true);
        await new Promise(resolve => setTimeout(resolve, this.lockRetryMs));
      }
    }
  }

  async #reload() {
    if (!this.filePath) return; this.#records.clear(); let text = '';
    try { text = await readFile(this.filePath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw ledgerError('EFFECT_LEDGER_REPLAY_FAILED', e.message, false); }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue; let entry;
      try { entry = JSON.parse(line); } catch (e) { throw ledgerError('EFFECT_LEDGER_REPLAY_FAILED', e.message, false); }
      if (entry.schemaVersion !== SCHEMA_VERSION || !entry.record || !['claim', 'committed', 'failed', 'recover'].includes(entry.op)) throw ledgerError('EFFECT_LEDGER_CORRUPT', 'Invalid effect ledger journal entry', false);
      this.#records.set(entry.record.effectKey, freeze(entry.record));
    }
    this.#enforceBound();
  }

  async #append(entry) {
    if (!this.filePath) return;
    await appendFile(this.filePath, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...entry }) + '\n', 'utf8');
    const handle = await open(this.filePath, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  }
  #purgeExpired(now = this.clock()) { for (const [key, record] of this.#records) if (record.status !== 'pending' && record.expiresAt <= now) this.#records.delete(key); }
  #enforceBound() { while (this.#records.size > this.maxRecords) this.#records.delete(this.#records.keys().next().value); }
  #assertReady() { if (!this.ready) throw new Error('DistributedEffectLedger.init() must be awaited before use when filePath is configured'); }
}

export function fingerprintEffect({ executionId, operation, input, capabilityFingerprint = null } = {}) {
  return createHash('sha256').update(canonicalize({ executionId, operation, input, capabilityFingerprint })).digest('hex');
}
function canonicalize(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new TypeError('fingerprint input must contain only JSON-like values');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
function normalizeScope(s) { return Object.freeze({ executionId: nullable(s.executionId, 'executionId'), operation: nullable(s.operation, 'operation'), workerId: nullable(s.workerId, 'workerId'), capabilityFingerprint: nullable(s.capabilityFingerprint, 'capabilityFingerprint') }); }
function sameScope(a, b) { return a.executionId === b.executionId && a.operation === b.operation && a.workerId === b.workerId && a.capabilityFingerprint === b.capabilityFingerprint; }
function nullable(v, n) { if (v == null) return null; if (typeof v !== 'string' || !v.trim()) throw new TypeError(n + ' must be null or a non-empty string'); return v; }
function normalizeKey(v, n) { if (typeof v !== 'string' || !v.trim()) throw new TypeError(n + ' must be a non-empty string'); const key = v.trim(); if (key.length > 512) throw new TypeError(n + ' must not exceed 512 characters'); return key; }
function assertFingerprint(v) { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) throw new TypeError('fingerprint must be a SHA-256 hex digest'); }
function validateFuture(v, now) { if (!Number.isFinite(v) || v <= now) throw new TypeError('expiresAt must be a future timestamp'); }
function normalizeError(e) { return { code: typeof e?.code === 'string' && e.code ? e.code : 'EFFECT_FAILED', message: e instanceof Error ? e.message : String(e ?? 'Effect failed'), retryable: Boolean(e?.retryable) }; }
function ledgerError(code, message, retryable) { return Object.assign(new Error(message), { code, retryable }); }
function clone(v) { return structuredClone(v); }
function freeze(v) { return deepFreeze(structuredClone(v)); }
function deepFreeze(v) { if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v; for (const c of Object.values(v)) deepFreeze(c); return Object.freeze(v); }
