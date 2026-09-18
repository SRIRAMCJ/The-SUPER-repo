const SCHEMA_VERSION = '0.1.0';
const SYNC_STATES = Object.freeze({
  idle: 'idle',
  syncing: 'syncing',
  succeeded: 'succeeded',
  partial: 'partial',
  failed: 'failed',
  cancelled: 'cancelled',
});

export class ObservabilitySyncCoordinator {
  #transport;
  #store;
  #clock;
  #idFactory;
  #maxHistory;
  #inflight = new Map();
  #history = [];

  constructor({ transport, store, clock = () => new Date(), idFactory = () => globalThis.crypto.randomUUID(), maxHistory = 1_000 } = {}) {
    if (!transport || typeof transport.ingest !== 'function' || typeof transport.history !== 'function') throw new TypeError('transport must expose ingest() and history()');
    if (!store || typeof store.replay !== 'function' || typeof store.snapshot !== 'function') throw new TypeError('store must expose replay() and snapshot()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.#transport = transport;
    this.#store = store;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#maxHistory = maxHistory;
  }

  async syncFrom({ sourceNodeId, afterSourceSequence = 0, limit = 1_000, signal } = {}) {
    validateNode(sourceNodeId);
    validateCursor(afterSourceSequence);
    validateLimit(limit);
    if (signal?.aborted) return this.#finish({ requestId: this.#idFactory(), sourceNodeId, state: SYNC_STATES.cancelled, imported: 0, rejected: 0, gap: null });
    const key = sourceNodeId + ':' + afterSourceSequence + ':' + limit;
    if (this.#inflight.has(key)) return this.#inflight.get(key);
    const operation = this.#runSync({ sourceNodeId, afterSourceSequence, limit, signal });
    this.#inflight.set(key, operation);
    try { return await operation; } finally { this.#inflight.delete(key); }
  }

  async #runSync({ sourceNodeId, afterSourceSequence, limit, signal }) {
    const requestId = this.#idFactory();
    this.#record({ requestId, sourceNodeId, state: SYNC_STATES.syncing, imported: 0, rejected: 0, gap: null });
    try {
      const events = await this.#store.replay({ afterSequence: 0, limit: Math.max(limit * 2, limit) });
      const sourceEvents = events.filter((event) => event.sourceNodeId === sourceNodeId && event.sourceSequence > afterSourceSequence).slice(0, limit);
      if (signal?.aborted) return this.#finish({ requestId, sourceNodeId, state: SYNC_STATES.cancelled, imported: 0, rejected: 0, gap: null });
      const gap = sourceEvents.length && sourceEvents[0].sourceSequence > afterSourceSequence + 1
        ? { from: afterSourceSequence + 1, to: sourceEvents[0].sourceSequence - 1 }
        : null;
      const results = this.#transport.ingest(sourceEvents);
      const imported = results.filter((result) => result.state === 'published').length;
      const rejected = results.length - imported;
      return this.#finish({ requestId, sourceNodeId, state: gap ? SYNC_STATES.partial : SYNC_STATES.succeeded, imported, rejected, gap });
    } catch (error) {
      if (signal?.aborted) return this.#finish({ requestId, sourceNodeId, state: SYNC_STATES.cancelled, imported: 0, rejected: 0, gap: null });
      return this.#finish({ requestId, sourceNodeId, state: SYNC_STATES.failed, imported: 0, rejected: 0, gap: null, error: normalizeError(error) });
    }
  }

  status() {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'observability-sync-coordinator',
      state: this.#inflight.size ? SYNC_STATES.syncing : SYNC_STATES.idle,
      inFlight: this.#inflight.size,
      history: this.#history,
      store: this.#store.snapshot(),
      transport: this.#transport.snapshot(),
    });
  }

  history() { return freeze(this.#history); }

  #record(entry) {
    this.#history.push(freeze({ ...entry, timestamp: this.#clock().toISOString() }));
    if (this.#history.length > this.#maxHistory) this.#history.splice(0, this.#history.length - this.#maxHistory);
  }

  #finish(result) {
    const normalized = freeze({ ...result, schemaVersion: SCHEMA_VERSION, completedAt: this.#clock().toISOString() });
    this.#record(normalized);
    return normalized;
  }
}

function validateNode(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('sourceNodeId must be a non-empty string'); }
function validateCursor(value) { if (!Number.isInteger(value) || value < 0) throw new TypeError('afterSourceSequence must be a non-negative integer'); }
function validateLimit(value) { if (!Number.isInteger(value) || value < 1) throw new TypeError('limit must be a positive integer'); }
function normalizeError(error) { return { code: typeof error?.code === 'string' ? error.code : 'OBSERVABILITY_SYNC_FAILED', message: error instanceof Error ? error.message : String(error) }; }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }

export { SCHEMA_VERSION as OBSERVABILITY_SYNC_SCHEMA_VERSION, SYNC_STATES as OBSERVABILITY_SYNC_STATES };
