import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MISSION_STORE_SCHEMA_VERSION = '0.2.0';

export class FileMissionStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('FileMissionStore requires a file path');
    this.filePath = path.resolve(filePath);
    this.loaded = false;
    this.writeQueue = Promise.resolve();
    this.records = new Map();
  }

  async init() { await this.#load(); return this; }

  async save(record, expectedVersion = null) {
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
    this.records.set(key, Object.freeze(structuredClone(next)));
    await this.#persist();
    return structuredClone(next);
  }

  async get(missionId) {
    await this.#load();
    return clone(this.records.get(missionId) ?? [...this.records.values()].find((record) => record.missionId === missionId || record.missionExecutionId === missionId) ?? null);
  }

  async list(filter = {}) {
    await this.#load();
    return [...this.records.values()].filter((record) => Object.entries(filter).every(([k,v]) => record[k] === v)).map(clone);
  }

  async #load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Mission store file must contain an array');
      for (const record of parsed) {
        validateRecord(record);
        if (!Number.isInteger(record.version) || record.version < 0) throw new TypeError('Invalid mission record version');
        const key = record.missionExecutionId ?? record.missionId;
        this.records.set(key, Object.freeze(structuredClone(record)));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async #persist() {
    const snapshot = [...this.records.values()];
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = this.filePath + '.' + process.pid + '.tmp';
      await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
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
