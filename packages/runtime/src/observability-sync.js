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
  #checkpoint;
  #inflight = new Map();
  #history = [];

  constructor({ transport, store, checkpoint = null, clock = () => new Date(), idFactory = () => globalThis.crypto.randomUUID(), maxHistory = 1_000 } = {}) {
    if (!transport || typeof transport.ingest !== 'function' || typeof transport.history !== 'function') throw new TypeError('transport must expose ingest() and history()');
    if (!store || typeof store.replay !== 'function' || typeof store.snapshot !== 'function') throw new TypeError('store must expose replay() and snapshot()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.#transport = transport;
    if (checkpoint !== null && (typeof checkpoint.get !== 'function' || typeof checkpoint.commit !== 'function')) throw new TypeError('checkpoint must expose get() and commit()');
    this.#store = store;
    this.#checkpoint = checkpoint;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#maxHistory = maxHistory;
  }

  async syncFrom({ sourceNodeId, afterSourceSequence, limit = 1_000, signal } = {}) {
    validateNode(sourceNodeId);
    if (afterSourceSequence !== undefined) validateCursor(afterSourceSequence);
    validateLimit(limit);
    const checkpoint = this.#checkpoint?.get(sourceNodeId);
    const cursor = afterSourceSequence ?? checkpoint?.sourceSequence ?? 0;
    if (signal?.aborted) return this.#finish({ requestId: this.#idFactory(), sourceNodeId, state: SYNC_STATES.cancelled, imported: 0, rejected: 0, gap: null });
    const key = sourceNodeId + ':' + cursor + ':' + limit;
    if (this.#inflight.has(key)) return this.#inflight.get(key);
    const operation = this.#runSync({ sourceNodeId, afterSourceSequence: cursor, limit, signal });
    this.#inflight.set(key, operation);
    try { return await operation; } finally { this.#inflight.delete(key); }
  }

  async #runSync({ sourceNodeId, afterSourceSequence, limit, signal }) {
    const requestId = this.#idFactory();
    this.#record({ requestId, sourceNodeId, state: SYNC_STATES.syncing, imported: 0, rejected: 0, gap: null });
    try {
      const sourceEvents = typeof this.#store.replaySource === 'function'
        ? await this.#store.replaySource({ sourceNodeId, afterSourceSequence, limit })
        : (await this.#store.replay({ afterSequence: 0, limit: Math.max(limit * 2, limit) })).filter((event) => event.sourceNodeId === sourceNodeId && event.sourceSequence > afterSourceSequence).slice(0, limit);
      if (signal?.aborted) return this.#finish({ requestId, sourceNodeId, state: SYNC_STATES.cancelled, imported: 0, rejected: 0, gap: null });
      const gap = sourceEvents.length && sourceEvents[0].sourceSequence > afterSourceSequence + 1
        ? { from: afterSourceSequence + 1, to: sourceEvents[0].sourceSequence - 1 }
        : null;
      const results = this.#transport.ingest(sourceEvents);
      const imported = results.filter((result) => result.state === 'published' || result.state === 'duplicate').length;
      const rejected = results.length - imported;
      let checkpointResult = null;
      if (!gap && sourceEvents.length && this.#checkpoint) {
        const last = sourceEvents[sourceEvents.length - 1];
        checkpointResult = this.#checkpoint.commit({
          nodeId: this.#transport.snapshot().nodeId ?? 'sync',
          sourceNodeId,
          sourceSequence: last.sourceSequence,
          eventSequence: last.sequence ?? last.sourceSequence,
          fencingToken: last.fencingToken ?? 0,
        });
        if (!['committed', 'duplicate'].includes(checkpointResult.state)) {
          return this.#finish({ requestId, sourceNodeId, state: SYNC_STATES.failed, imported, rejected, gap: null, checkpoint: checkpointResult.state, error: { code: 'CHECKPOINT_COMMIT_REJECTED', message: 'checkpoint advancement was rejected' } });
        }
      }
      return this.#finish({ requestId, sourceNodeId, state: gap ? SYNC_STATES.partial : SYNC_STATES.succeeded, imported, rejected, gap, checkpoint: checkpointResult?.state ?? null });
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
      checkpoint: this.#checkpoint?.get ? this.#checkpoint.get('') : null,
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
