import { readFile } from 'node:fs/promises';
import { writeAtomicJson } from './atomic-json.js';
import path from 'node:path';

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
  #loadPromise = null;
  #queue = Promise.resolve();
  constructor(filePath) {
    super();
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('FileExecutionStateStore requires a file path');
    this.filePath = path.resolve(filePath);
  }

  #load() {
    if (!this.#loadPromise) this.#loadPromise = (async () => {
      let parsed;
      try { parsed = JSON.parse(await readFile(this.filePath, 'utf8')); }
      catch (error) { if (error?.code === 'ENOENT') parsed = []; else throw error; }
      await super.restore(parsed);
    })();
    return this.#loadPromise;
  }

  #run(operation, persist = false) {
    const result = this.#queue.then(async () => {
      await this.#load();
      const before = persist ? await super.list() : null;
      try {
        const value = await operation();
        if (persist) await writeAtomicJson(this.filePath, await super.list());
        return value;
      } catch (error) {
        if (persist) await super.restore(before);
        throw error;
      }
    });
    this.#queue = result.catch(() => {});
    return result;
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
