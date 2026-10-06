import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { writeAtomicJson } from './atomic-json.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const MISSION_STORE_SCHEMA_VERSION = '0.2.0';

export class FileMissionStore {
  #loadPromise = null;
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('FileMissionStore requires a file path');
    this.filePath = path.resolve(filePath);
    this.loaded = false;
    this.fileExisted = false;
    this.writeQueue = Promise.resolve();
    this.records = new Map();
  }

  async init() { await this.#load(); return this; }

  async save(record, expectedVersion = null) {
    record = structuredClone(record);
    return this.#enqueue(async () => {
    return this.#withLock(async () => {
    const records = await this.#readRecords();
    validateRecord(record);
    const key = record.missionExecutionId ?? record.missionId;
    const current = records.get(key);
    if ((current && expectedVersion === null) ||
        (expectedVersion !== null && (!current || current.version !== expectedVersion))) {
      throw conflict(record.missionId, expectedVersion, current?.version ?? null);
    }
    if (current?.recoveryLease &&
        (current.recoveryLease.expiresAt <= Date.now() || record.recoveryLease?.token !== current.recoveryLease.token)) {
      throw leaseConflict(key, current.recoveryLease.owner, current.recoveryLease.expiresAt);
    }
    const next = {
      ...structuredClone(record),
      schemaVersion: MISSION_STORE_SCHEMA_VERSION,
      version: (current?.version ?? -1) + 1,
      updatedAt: new Date().toISOString()
    };
    records.set(key, Object.freeze(structuredClone(next)));
    await writeAtomicJson(this.filePath, [...records.values()]);
    this.records = records;
    this.loaded = true;
    this.fileExisted = true;
    return structuredClone(next);
    });
    });
  }

  async claimRecovery(missionExecutionId, owner, leaseMs = 30000) {
    if (typeof owner !== 'string' || !owner) throw new TypeError('Recovery owner is required');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new TypeError('Recovery lease must be at least 1000ms');
    return this.#enqueue(() => this.#withLock(async () => {
      const records = await this.#readRecords();
      const record = records.get(missionExecutionId);
      if (!record) return null;
      const now = Date.now();
      if (record.recoveryLease?.expiresAt > now) throw leaseConflict(missionExecutionId, record.recoveryLease.owner, record.recoveryLease.expiresAt);
      if (record.status !== 'executing' && record.status !== 'recovering') return structuredClone(record);
      const next = { ...record, version: record.version + 1, updatedAt: new Date(now).toISOString(),
        recoveryLease: { owner, token: randomUUID(), acquiredAt: new Date(now).toISOString(), expiresAt: now + leaseMs } };
      records.set(missionExecutionId, Object.freeze(structuredClone(next)));
      await writeAtomicJson(this.filePath, [...records.values()]);
      this.records = records;
      this.loaded = true;
      this.fileExisted = true;
      return structuredClone(next);
    }));
  }

  async releaseRecovery(missionExecutionId, token) {
    return this.#enqueue(() => this.#withLock(async () => {
      const records = await this.#readRecords();
      const record = records.get(missionExecutionId);
      if (!record) return null;
      if (!record.recoveryLease || record.recoveryLease.token !== token) {
        throw leaseConflict(missionExecutionId, record.recoveryLease?.owner ?? null, record.recoveryLease?.expiresAt ?? null);
      }
      const next = { ...record, version: record.version + 1, updatedAt: new Date().toISOString(), recoveryLease: null };
      records.set(missionExecutionId, Object.freeze(structuredClone(next)));
      await writeAtomicJson(this.filePath, [...records.values()]);
      this.records = records;
      this.loaded = true;
      this.fileExisted = true;
      return structuredClone(next);
    }));
  }

  async get(missionId) {
    await this.writeQueue;
    await this.#load();
    this.records = await this.#readRecords();
    return clone(this.records.get(missionId) ?? [...this.records.values()].find((record) => record.missionId === missionId || record.missionExecutionId === missionId) ?? null);
  }

  async list(filter = {}) {
    await this.writeQueue;
    await this.#load();
    this.records = await this.#readRecords();
    return [...this.records.values()].filter((record) => Object.entries(filter).every(([k,v]) => record[k] === v)).map(clone);
  }

  #load() {
    if (!this.#loadPromise) this.#loadPromise = this.#read();
    return this.#loadPromise;
  }

  async #read() {
    this.records = await this.#readRecords();
    this.loaded = true;
  }

  async #readRecords() {
    let parsed;
    try { parsed = JSON.parse(await readFile(this.filePath, 'utf8')); this.fileExisted = true; }
    catch (error) { if (error?.code === 'ENOENT' && !this.fileExisted) parsed = []; else throw error; }
    if (!Array.isArray(parsed)) throw new Error('Mission store file must contain an array');
    const records = new Map();
    for (const record of parsed) {
      validateRecord(record);
      if (!Number.isInteger(record.version) || record.version < 0) throw new TypeError('Invalid mission record version');
      const key = record.missionExecutionId ?? record.missionId;
      if (records.has(key)) throw new TypeError('Duplicate mission record');
      records.set(key, Object.freeze(structuredClone(record)));
    }
    return records;
  }

  async #withLock(operation) {
    const lockPath = this.filePath + '.lock';
    await mkdir(path.dirname(lockPath), { recursive: true });
    const deadline = performance.now() + 5000;
    while (true) {
      try { await mkdir(lockPath); break; }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (performance.now() >= deadline) throw Object.assign(new Error('Mission store lock timeout'), { code: 'MISSION_STORE_LOCK_TIMEOUT', retryable: true });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try { return await operation(); }
    finally { await rmdir(lockPath); }
  }

  #enqueue(operation) {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.catch(() => {});
    return result;
  }

}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.missionId !== 'string' || !record.missionId) throw new TypeError('Mission record requires missionId');
  if (record.missionExecutionId !== undefined && (typeof record.missionExecutionId !== 'string' || !record.missionExecutionId)) throw new TypeError('Mission record missionExecutionId must be a non-empty string');
}
function conflict(missionId, expectedVersion, actualVersion) {
  return Object.assign(new Error('Mission state version conflict: ' + missionId), { code: 'MISSION_STATE_CONFLICT', retryable: true, expectedVersion, actualVersion });
}
function leaseConflict(id, owner, expiresAt) {
  return Object.assign(new Error('Recovery lease held: ' + id), { code: 'MISSION_RECOVERY_LEASE_HELD', retryable: true, owner, expiresAt });
}
function clone(value) { return value === null ? null : structuredClone(value); }
