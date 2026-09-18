const SCHEMA_VERSION = '0.2.0';
const CHECKPOINT_VERSION = 1;

export class ObservabilityCheckpointAuthority {
  #clock;
  #idFactory;
  #maxHistory;
  #store;
  #checkpoints = new Map();
  #history = [];

  constructor({ clock = () => new Date(), idFactory = () => globalThis.crypto.randomUUID(), maxHistory = 1_000, store = null } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.#clock = clock;
    this.#idFactory = idFactory;
    if (store !== null && (typeof store.replay !== 'function' || typeof store.append !== 'function')) throw new TypeError('store must expose replay() and append()');
    this.#maxHistory = maxHistory;
    this.#store = store;
    if (this.#store) for (const checkpoint of this.#store.replay()) this.#checkpoints.set(checkpoint.sourceNodeId, freeze(checkpoint));
  }

  commit({ nodeId, sourceNodeId, sourceSequence, fencingToken, eventSequence, digest = null, expectedVersion = null } = {}) {
    validateNode(nodeId);
    validateNode(sourceNodeId);
    validatePositive(sourceSequence, 'sourceSequence');
    validatePositive(eventSequence, 'eventSequence');
    validateNonNegative(fencingToken, 'fencingToken');
    if (digest !== null && (typeof digest !== 'string' || digest.length > 256)) throw new TypeError('digest must be a string of <= 256 characters or null');
    if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) throw new TypeError('expectedVersion must be a non-negative integer or null');
    const current = this.#checkpoints.get(sourceNodeId);
    const currentVersion = current?.version ?? 0;
    if (expectedVersion !== null && expectedVersion !== currentVersion) return this.#result('version_conflict', { sourceNodeId, expectedVersion, currentVersion, checkpoint: current ?? null });
    if (current) {
      if (fencingToken < current.fencingToken) return this.#result('stale_fence', { sourceNodeId, fencingToken, currentFencingToken: current.fencingToken });
      if (sourceSequence < current.sourceSequence) return this.#result('stale', { sourceNodeId, sourceSequence, currentSourceSequence: current.sourceSequence });
      if (sourceSequence === current.sourceSequence && eventSequence === current.eventSequence && fencingToken === current.fencingToken) return this.#result('duplicate', { checkpoint: current });
      if (sourceSequence === current.sourceSequence && eventSequence <= current.eventSequence) return this.#result('conflict', { sourceNodeId, sourceSequence, eventSequence, currentEventSequence: current.eventSequence });
    }
    const checkpoint = freeze({
      schemaVersion: SCHEMA_VERSION,
      version: currentVersion + CHECKPOINT_VERSION,
      checkpointId: this.#idFactory(),
      nodeId,
      sourceNodeId,
      sourceSequence,
      eventSequence,
      fencingToken,
      digest,
      committedAt: this.#clock().toISOString(),
    });
    if (this.#store) {
      const persisted = this.#store.append(checkpoint);
      if (persisted.state !== 'committed') return this.#result(persisted.state, { sourceNodeId, checkpoint: persisted.checkpoint });
    }
    this.#checkpoints.set(sourceNodeId, checkpoint);
    this.#record({ type: 'committed', checkpoint });
    return this.#result('committed', { checkpoint });
  }

  get(sourceNodeId) {
    validateNode(sourceNodeId);
    const checkpoint = this.#checkpoints.get(sourceNodeId);
    return checkpoint ? clone(checkpoint) : null;
  }

  list() { return Object.freeze([...this.#checkpoints.values()].map(clone)); }

  validate({ sourceNodeId, sourceSequence, fencingToken, eventSequence } = {}) {
    const checkpoint = this.get(sourceNodeId);
    if (!checkpoint) return freeze({ valid: false, code: 'CHECKPOINT_MISSING' });
    if (fencingToken < checkpoint.fencingToken) return freeze({ valid: false, code: 'CHECKPOINT_STALE_FENCE', checkpoint });
    if (sourceSequence < checkpoint.sourceSequence) return freeze({ valid: false, code: 'CHECKPOINT_STALE_SOURCE', checkpoint });
    if (eventSequence !== undefined && eventSequence < checkpoint.eventSequence) return freeze({ valid: false, code: 'CHECKPOINT_STALE_EVENT', checkpoint });
    return freeze({ valid: true, checkpoint });
  }

  snapshot() {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'observability-checkpoint-authority',
      checkpoints: Object.fromEntries([...this.#checkpoints].map(([key, value]) => [key, clone(value)])),
      history: this.#history,
    });
  }

  history() { return freeze(this.#history); }

  #result(state, payload) {
    return freeze({ schemaVersion: SCHEMA_VERSION, state, ...payload });
  }

  #record(entry) {
    this.#history.push(freeze({ eventId: this.#idFactory(), ...entry, timestamp: this.#clock().toISOString() }));
    if (this.#history.length > this.#maxHistory) this.#history.splice(0, this.#history.length - this.#maxHistory);
  }
}

function validateNode(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('nodeId must be a non-empty string'); }
function validatePositive(value, name) { if (!Number.isInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer'); }
function validateNonNegative(value, name) { if (!Number.isInteger(value) || value < 0) throw new TypeError(name + ' must be a non-negative integer'); }
function clone(value) { return structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }

export { SCHEMA_VERSION as OBSERVABILITY_CHECKPOINT_SCHEMA_VERSION, CHECKPOINT_VERSION as OBSERVABILITY_CHECKPOINT_VERSION };
