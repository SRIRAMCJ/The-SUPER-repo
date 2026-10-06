import { readFile } from 'node:fs/promises';
import { writeAtomicJson } from './atomic-json.js';
import path from 'node:path';

export const MISSION_STORE_SCHEMA_VERSION = '0.2.0';

export class FileMissionStore {
  #loadPromise = null;
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('FileMissionStore requires a file path');
    this.filePath = path.resolve(filePath);
    this.loaded = false;
    this.writeQueue = Promise.resolve();
    this.records = new Map();
  }

  async init() { await this.#load(); return this; }

  async save(record, expectedVersion = null) {
    record = structuredClone(record);
    return this.#enqueue(async () => {
    await this.#load();
    validateRecord(record);
    const key = record.missionExecutionId ?? record.missionId;
    const current = this.records.get(key);
    if (expectedVersion !== null && (!current || current.version !== expectedVersion)) {
      throw conflict(record.missionId, expectedVersion, current?.version ?? null);
    }
    const next = {
      ...structuredClone(record),
      schemaVersion: MISSION_STORE_SCHEMA_VERSION,
      version: (current?.version ?? -1) + 1,
      updatedAt: new Date().toISOString()
    };
    const records = new Map(this.records);
    records.set(key, Object.freeze(structuredClone(next)));
    await writeAtomicJson(this.filePath, [...records.values()]);
    this.records = records;
    return structuredClone(next);
    });
  }

  async get(missionId) {
    await this.writeQueue;
    await this.#load();
    return clone(this.records.get(missionId) ?? [...this.records.values()].find((record) => record.missionId === missionId || record.missionExecutionId === missionId) ?? null);
  }

  async list(filter = {}) {
    await this.writeQueue;
    await this.#load();
    return [...this.records.values()].filter((record) => Object.entries(filter).every(([k,v]) => record[k] === v)).map(clone);
  }

  #load() {
    if (!this.#loadPromise) this.#loadPromise = this.#read();
    return this.#loadPromise;
  }

  async #read() {
    let parsed;
    try { parsed = JSON.parse(await readFile(this.filePath, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') parsed = []; else throw error; }
    if (!Array.isArray(parsed)) throw new Error('Mission store file must contain an array');
    const records = new Map();
    for (const record of parsed) {
      validateRecord(record);
      if (!Number.isInteger(record.version) || record.version < 0) throw new TypeError('Invalid mission record version');
      const key = record.missionExecutionId ?? record.missionId;
      if (records.has(key)) throw new TypeError('Duplicate mission record');
      records.set(key, Object.freeze(structuredClone(record)));
    }
    this.records = records;
    this.loaded = true;
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
function clone(value) { return value === null ? null : structuredClone(value); }
