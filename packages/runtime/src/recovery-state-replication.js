import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['detected', 'leased', 'recovering', 'succeeded', 'failed', 'cancelled', 'blocked']);

export class RecoveryStateReplicator {
  constructor({ filePath, clock = () => new Date(), idFactory = defaultId, maxRecords = 10_000 } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath must be a non-empty string');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be positive');
    this.filePath = path.resolve(filePath); this.clock = clock; this.idFactory = idFactory; this.maxRecords = maxRecords;
    this.writeQueue = Promise.resolve(); this.latest = new Map(); this.loaded = false;
  }

  async append(input = {}) {
    const record = this.validate(input);
    await this.load();
    const decision = this.checkConflict(record);
    if (decision === 'duplicate') return clone(this.latest.get(record.transactionId));
    this.assertWritable(decision);
    await this.persist(record);
    this.applyToMemory(record);
    return clone(record);
  }

  async apply(record) {
    const normalized = this.validate(record);
    await this.load();
    const decision = this.checkConflict(normalized);
    if (decision === 'duplicate') return { applied: false, duplicate: true, record: clone(this.latest.get(normalized.transactionId)) };
    this.assertWritable(decision);
    await this.persist(normalized);
    this.applyToMemory(normalized);
    return { applied: true, duplicate: false, record: clone(normalized) };
  }

  async load() {
    if (this.loaded) return this.snapshot();
    let records = [];
    try {
      const content = await readFile(this.filePath, 'utf8');
      records = content.split('\\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw Object.assign(new Error(`Recovery state replay failed: ${error.message}`), { code: 'RECOVERY_STATE_REPLAY_FAILED', retryable: true, cause: error });
    }
    for (const record of records) {
      const normalized = this.validate(record);
      const decision = this.checkConflict(normalized);
      if (decision === 'duplicate') continue;
      this.assertWritable(decision, true);
      this.applyToMemory(normalized);
    }
    this.loaded = true;
    return this.snapshot();
  }

  get(transactionId) { return clone(this.latest.get(transactionId) ?? null); }
  list() { return [...this.latest.values()].map(clone); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, type: 'recovery-state-replicator', records: this.list() }); }

  validate(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Recovery state record must be an object');
    const { transactionId, sequence, state, ownerId, nodeId, fencingToken } = record;
    if (typeof transactionId !== 'string' || !transactionId) throw new TypeError('transactionId is required');
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('sequence must be positive');
    if (!STATES.includes(state)) throw new TypeError(`unsupported recovery state: ${state}`);
    if (typeof ownerId !== 'string' || !ownerId || typeof nodeId !== 'string' || !nodeId) throw new TypeError('ownerId and nodeId are required');
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new TypeError('fencingToken must be positive');
    const value = {
      schemaVersion: SCHEMA_VERSION, recordId: record.recordId ?? this.idFactory('recovery-state'),
      transactionId, sequence, state, ownerId, nodeId, fencingToken,
      recoveryId: record.recoveryId ?? null, requestId: record.requestId ?? null,
      reason: record.reason ?? null, result: clone(record.result), error: clone(record.error),
      timestamp: record.timestamp ?? this.nowIso()
    };
    if (typeof value.recordId !== 'string' || !value.recordId) throw new TypeError('recordId must be non-empty');
    return freeze(value);
  }

  checkConflict(record) {
    const current = this.latest.get(record.transactionId);
    if (!current) return 'new';
    if (record.sequence < current.sequence) return 'stale';
    if (record.sequence === current.sequence) return sameIdentity(record, current) ? 'duplicate' : 'conflict';
    if (record.fencingToken < current.fencingToken) return 'fence';
    if (isTerminal(current.state) && !isTerminal(record.state)) return 'stale';
    return 'new';
  }

  assertWritable(decision, replay = false) {
    if (decision === 'new') return;
    if (replay) throw recoveryError('RECOVERY_STATE_REPLAY_CONFLICT', 'Durable recovery state contains conflicting records');
    if (decision === 'stale') throw recoveryError('RECOVERY_STATE_STALE', 'Recovery state is older than current state');
    if (decision === 'fence') throw recoveryError('RECOVERY_STATE_FENCED', 'Recovery state has a stale fencing token');
    if (decision === 'conflict') throw recoveryError('RECOVERY_STATE_CONFLICT', 'Recovery state conflicts at the same sequence');
  }

  applyToMemory(record) { this.latest.set(record.transactionId, record); }

  async persist(record) {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await open(this.filePath, 'a');
      try { await handle.writeFile(JSON.stringify(record) + '\\n', 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await this.compact();
    });
    await this.writeQueue;
  }

  async compact() {
    const content = await readFile(this.filePath, 'utf8').catch(() => '');
    if (content.split('\\n').filter(Boolean).length <= this.maxRecords) return;
    const retained = [...this.latest.values()].slice(-this.maxRecords);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const handle = await open(temporaryPath, 'w');
    try { await handle.writeFile(retained.map(JSON.stringify).join('\\n') + '\\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporaryPath, this.filePath);
  }

  nowIso() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return valid Date'); return value.toISOString(); }
}

function isTerminal(state) { return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'blocked'; }
function sameIdentity(a, b) { return a.recordId === b.recordId && a.ownerId === b.ownerId && a.nodeId === b.nodeId && a.fencingToken === b.fencingToken && a.state === b.state; }
function recoveryError(code, message) { return Object.assign(new Error(message), { code, retryable: false }); }
function clone(value) { return value == null ? value : structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function defaultId(prefix) { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as RECOVERY_STATE_REPLICATION_SCHEMA_VERSION, STATES as RECOVERY_STATE_REPLICATION_STATES };
