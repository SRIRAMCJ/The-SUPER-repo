import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

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
}

export class FileExecutionStateStore extends ExecutionStateStore {
  constructor(filePath) {
    super();
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('FileExecutionStateStore requires a file path');
    this.filePath = path.resolve(filePath);
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async #load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Execution state file must contain an array');
      for (const state of parsed) {
        validateStateIdentity(state);
        await super.create(state);
        await super.update(state.executionId, state, 0);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async #persist() {
    const snapshot = await super.list();
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  async create(state) {
    await this.#load();
    const result = await super.create(state);
    await this.#persist();
    return result;
  }

  async get(executionId) {
    await this.#load();
    return super.get(executionId);
  }

  async update(executionId, patch, expectedVersion = null) {
    await this.#load();
    const result = await super.update(executionId, patch, expectedVersion);
    await this.#persist();
    return result;
  }

  async list(filter = {}) {
    await this.#load();
    return super.list(filter);
  }

  async remove(executionId) {
    await this.#load();
    const result = await super.remove(executionId);
    await this.#persist();
    return result;
  }
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
