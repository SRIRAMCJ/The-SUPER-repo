import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const MISSION_STORE_SCHEMA_VERSION = '0.3.0';

export class FileMissionStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('FileMissionStore requires a file path');
    this.filePath = path.resolve(filePath);
    this.lockPath = this.filePath + '.lock';
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
    if (expectedVersion !== null && (!current || current.version !== expectedVersion)) throw conflict(record.missionId, expectedVersion, current?.version ?? null);
    const next = { ...structuredClone(record), schemaVersion: MISSION_STORE_SCHEMA_VERSION, version: (current?.version ?? -1) + 1, updatedAt: new Date().toISOString() };
    this.records.set(key, Object.freeze(structuredClone(next)));
    await this.#persist();
    return structuredClone(next);
  }

  async claimRecovery(missionExecutionId, owner, leaseMs = 30000) {
    if (typeof owner !== 'string' || !owner) throw new TypeError('Recovery lease owner is required');
    if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new TypeError('Recovery lease must be at least 1000ms');
    return this.#withFileLock(async () => {
      await this.#reload();
      const record = this.records.get(missionExecutionId) ?? [...this.records.values()].find((item) => item.missionExecutionId === missionExecutionId);
      if (!record) return null;
      const now = Date.now();
      const lease = record.recoveryLease;
      if (lease && lease.expiresAt > now && lease.owner !== owner) {
        throw recoveryConflict(missionExecutionId, lease.owner, lease.expiresAt);
      }
      const next = { ...record, recoveryLease: { owner, acquiredAt: new Date(now).toISOString(), expiresAt: now + leaseMs } };
      this.records.set(missionExecutionId, Object.freeze(structuredClone(next)));
      await this.#persistUnlocked();
      return structuredClone(next);
    });
  }

  async releaseRecovery(missionExecutionId, owner) {
    return this.#withFileLock(async () => {
      await this.#reload();
      const record = this.records.get(missionExecutionId) ?? [...this.records.values()].find((item) => item.missionExecutionId === missionExecutionId);
      if (!record) return null;
      if (record.recoveryLease?.owner !== owner) throw recoveryConflict(missionExecutionId, record.recoveryLease?.owner ?? null, record.recoveryLease?.expiresAt ?? null);
      const next = { ...record, recoveryLease: null };
      this.records.set(missionExecutionId, Object.freeze(structuredClone(next)));
      await this.#persistUnlocked();
      return structuredClone(next);
    });
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
    await this.#readIntoMemory();
  }

  async #reload() {
    this.records.clear();
    await this.#readIntoMemory();
    this.loaded = true;
  }

  async #readIntoMemory() {
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
    this.writeQueue = this.writeQueue.then(() => this.#persistUnlocked());
    return this.writeQueue;
  }

  async #persistUnlocked() {
    const snapshot = [...this.records.values()];
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = this.filePath + '.' + process.pid + '.tmp';
    const payload = JSON.stringify(snapshot, null, 2);
    const handle = await open(temporaryPath, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
    const directoryHandle = await open(path.dirname(this.filePath), 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  async #withFileLock(operation) {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await mkdir(this.lockPath);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' || Date.now() >= deadline) throw recoveryLockConflict(this.filePath);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.missionId !== 'string' || !record.missionId) throw new TypeError('Mission record requires missionId');
  if (record.missionExecutionId !== undefined && (typeof record.missionExecutionId !== 'string' || !record.missionExecutionId)) throw new TypeError('Mission record missionExecutionId must be a non-empty string');
}
function conflict(missionId, expectedVersion, actualVersion) {
  return Object.assign(new Error('Mission state version conflict: ' + missionId), { code: 'MISSION_STATE_CONFLICT', retryable: true, expectedVersion, actualVersion });
}
function recoveryConflict(id, owner, expiresAt) {
  return Object.assign(new Error('Recovery lease already held: ' + id), { code: 'MISSION_RECOVERY_LEASE_HELD', retryable: true, owner, expiresAt });
}
function recoveryLockConflict(filePath) {
  return Object.assign(new Error('Mission store lock unavailable: ' + filePath), { code: 'MISSION_STORE_LOCK_TIMEOUT', retryable: true });
}
function clone(value) { return value === null ? null : structuredClone(value); }


async function syncDirectory(directory) {
  try {
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  }
}
