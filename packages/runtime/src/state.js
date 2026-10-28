import { readFile, mkdir, open } from 'node:fs/promises';
import { writeAtomicJson } from './atomic-json.js';
import path from 'node:path';
import { withKernelFileLock } from './kernel-file-lock.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'rolled_back']);

export class ExecutionStateStore {
  #states = new Map();

  async create(state) {
    validateStateIdentity(state);
    if (this.#states.has(state.executionId)) throw stateConflict(`Execution state already exists: ${state.executionId}`);
    const now = state.updatedAt ?? state.createdAt ?? new Date().toISOString();
    const record = freezeState({ ...state, version: 0, createdAt: state.createdAt ?? now, updatedAt: now });
    this.#states.set(record.executionId, record);
    return clone(record);
  }

  async get(executionId) {
    const state = this.#states.get(executionId);
    return state ? clone(state) : null;
  }

  async update(executionId, patch, expectedVersion = null) {
    const current = this.#states.get(executionId);
    if (!current) throw Object.assign(new Error(`Execution state not found: ${executionId}`), { code: 'EXECUTION_STATE_NOT_FOUND', retryable: false });
    if (expectedVersion !== null && expectedVersion !== current.version) {
      throw Object.assign(new Error(`Execution state version conflict: expected ${expectedVersion}, actual ${current.version}`), { code: 'EXECUTION_STATE_CONFLICT', retryable: true, expectedVersion, actualVersion: current.version });
    }
    const next = freezeState({ ...current, ...patch, executionId: current.executionId, version: current.version + 1, updatedAt: patch.updatedAt ?? new Date().toISOString() });
    this.#states.set(executionId, next);
    return clone(next);
  }

  async list(filter = {}) {
    return [...this.#states.values()].filter((state) => Object.entries(filter).every(([key, value]) => state[key] === value)).map(clone);
  }

  async remove(executionId) {
    return this.#states.delete(executionId);
  }

  async restore(states) {
    if (!Array.isArray(states)) throw new TypeError('Execution states must be an array');
    const restored = new Map();
    for (const state of states) {
      validateStateIdentity(state);
      if (!Number.isInteger(state.version) || state.version < 0) throw new TypeError(`Invalid execution state version: ${state.executionId}`);
      if (restored.has(state.executionId)) throw new TypeError(`Duplicate execution state: ${state.executionId}`);
      restored.set(state.executionId, freezeState(state));
    }
    this.#states = restored;
    return [...this.#states.values()].map(clone);
  }
}

export class FileExecutionStateStore extends ExecutionStateStore {
  constructor(filePath, { maxRecords = 10_000, maxBytes = 16_777_216, lockTimeoutMs = 5_000 } = {}) {
    super();
    if (process.platform !== 'linux') throw new Error('FileExecutionStateStore requires Linux flock');
    if (typeof filePath !== 'string' || !filePath ||
        !Number.isSafeInteger(maxRecords) || maxRecords < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1024 ||
        !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError('Invalid FileExecutionStateStore configuration');
    this.filePath = path.resolve(filePath);
    Object.assign(this, { maxRecords, maxBytes, lockTimeoutMs });
  }

  async #load() {
    let initialized = false;
    try {
      const marker = JSON.parse(await readFile(`${this.filePath}.initialized`, 'utf8'));
      if (marker?.schemaVersion !== '0.1.0' || marker.initialized !== true) throw new Error('Invalid execution state marker');
      initialized = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let parsed, fileExists = false;
    try {
      const handle = await open(this.filePath, 'r');
      try {
        if ((await handle.stat()).size > this.maxBytes) throw new Error('Execution state file exceeds byte limit');
        parsed = JSON.parse(await handle.readFile('utf8'));
        fileExists = true;
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'ENOENT' || initialized) throw error;
      parsed = [];
    }
    if (!Array.isArray(parsed) || parsed.length > this.maxRecords) throw new Error('Invalid execution state file');
    await super.restore(parsed);
    if (fileExists && !initialized) await this.#markInitialized();
  }

  async #markInitialized() {
    let marker;
    try {
      marker = await open(`${this.filePath}.initialized`, 'wx', 0o600);
      await marker.writeFile(JSON.stringify({ schemaVersion: '0.1.0', initialized: true }));
      await marker.sync();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await marker?.close(); }
  }

  async #run(operation, persist = false) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    return withKernelFileLock(`${this.filePath}.flock`, this.lockTimeoutMs, async () => {
      await this.#load();
      const value = await operation();
      if (persist) {
        const records = await super.list();
        const encoded = JSON.stringify(records);
        if (records.length > this.maxRecords || Buffer.byteLength(encoded) > this.maxBytes) throw new Error('Execution state capacity exceeded');
        await this.#markInitialized();
        await writeAtomicJson(this.filePath, records, { space: 0 });
      }
      return value;
    });
  }

  create(state) { const snapshot = clone(state); return this.#run(() => super.create(snapshot), true); }
  get(executionId) { return this.#run(() => super.get(executionId)); }
  update(executionId, patch, expectedVersion = null) { const snapshot = clone(patch); return this.#run(() => super.update(executionId, snapshot, expectedVersion), true); }
  list(filter = {}) { return this.#run(() => super.list(filter)); }
  remove(executionId) { return this.#run(() => super.remove(executionId), true); }
  restore(states) { const snapshot = clone(states); return this.#run(() => super.restore(snapshot), true); }
}

export function isTerminalExecutionStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function validateStateIdentity(state) {
  if (!state || typeof state !== 'object') throw new TypeError('Execution state must be an object');
  if (typeof state.executionId !== 'string' || !state.executionId) throw new TypeError('Execution state requires executionId');
  if (typeof state.type !== 'string' || !state.type) throw new TypeError('Execution state requires type');
}

function stateConflict(message) {
  return Object.assign(new Error(message), { code: 'EXECUTION_STATE_EXISTS', retryable: false });
}

function freezeState(state) {
  return Object.freeze(structuredClone(state));
}

function clone(value) {
  return structuredClone(value);
}
