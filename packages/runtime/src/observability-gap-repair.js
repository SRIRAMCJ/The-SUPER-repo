const SCHEMA_VERSION = '0.1.0';
const REPAIR_STATES = Object.freeze({
  idle: 'idle',
  repairing: 'repairing',
  succeeded: 'succeeded',
  failed: 'failed',
  blocked: 'blocked',
  cancelled: 'cancelled',
});

export class ObservabilityGapRepairCoordinator {
  #source;
  #transport;
  #checkpoint;
  #clock;
  #idFactory;
  #maxHistory;
  #maxAttempts;
  #inflight = new Map();
  #attempts = new Map();
  #history = [];
  #state = REPAIR_STATES.idle;

  constructor({
    source,
    transport,
    checkpoint = null,
    clock = () => new Date(),
    idFactory = () => globalThis.crypto.randomUUID(),
    maxHistory = 1_000,
    maxAttempts = 3,
  } = {}) {
    if (!source || typeof source.repair !== 'function') throw new TypeError('source must expose repair()');
    if (!transport || typeof transport.ingest !== 'function' || typeof transport.snapshot !== 'function') throw new TypeError('transport must expose ingest() and snapshot()');
    if (checkpoint !== null && (typeof checkpoint.get !== 'function' || typeof checkpoint.commit !== 'function')) throw new TypeError('checkpoint must expose get() and commit()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
    this.#source = source;
    this.#transport = transport;
    this.#checkpoint = checkpoint;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#maxHistory = maxHistory;
    this.#maxAttempts = maxAttempts;
  }

  async repair({ sourceNodeId, fromSourceSequence, toSourceSequence, fencingToken = 0, signal, force = false } = {}) {
    validateNode(sourceNodeId);
    validateRange(fromSourceSequence, toSourceSequence);
    validateFence(fencingToken);
    const key = sourceNodeId + ':' + fromSourceSequence + ':' + toSourceSequence;
    if (this.#inflight.has(key)) return this.#inflight.get(key);
    const operation = this.#run({ sourceNodeId, fromSourceSequence, toSourceSequence, fencingToken, signal, force });
    this.#inflight.set(key, operation);
    try { return await operation; } finally { this.#inflight.delete(key); }
  }

  attempts(sourceNodeId, fromSourceSequence, toSourceSequence) {
    validateNode(sourceNodeId);
    validateRange(fromSourceSequence, toSourceSequence);
    return this.#attempts.get(sourceNodeId + ':' + fromSourceSequence + ':' + toSourceSequence) ?? 0;
  }

  status() {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'observability-gap-repair-coordinator',
      state: this.#state,
      inFlight: this.#inflight.size,
      attempts: Object.fromEntries(this.#attempts),
      history: this.#history,
    });
  }

  history() { return freeze(this.#history); }

  async #run({ sourceNodeId, fromSourceSequence, toSourceSequence, fencingToken, signal, force }) {
    const requestId = this.#idFactory();
    const key = sourceNodeId + ':' + fromSourceSequence + ':' + toSourceSequence;
    if (signal?.aborted) return this.#finish({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: REPAIR_STATES.cancelled, repaired: 0 });
    const prior = this.#attempts.get(key) ?? 0;
    if (prior >= this.#maxAttempts && !force) {
      this.#state = REPAIR_STATES.blocked;
      return this.#finish({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: REPAIR_STATES.blocked, repaired: 0, attempts: prior, error: { code: 'REPAIR_ATTEMPT_LIMIT', message: 'repair attempt limit reached; force is required to retry' } });
    }
    const attempt = prior + 1;
    this.#attempts.set(key, attempt);
    this.#state = REPAIR_STATES.repairing;
    this.#record({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: REPAIR_STATES.repairing, attempt });

    try {
      if (this.#checkpoint) {
        const current = this.#checkpoint.get(sourceNodeId);
        if (current && fencingToken < current.fencingToken) {
          this.#state = REPAIR_STATES.blocked;
          return this.#finish({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: REPAIR_STATES.blocked, repaired: 0, attempt, error: { code: 'CHECKPOINT_STALE_FENCE', message: 'repair fencing token is stale' } });
        }
      }
      const events = await this.#source.repair({
        sourceNodeId,
        fromSourceSequence,
        toSourceSequence,
        signal,
        requestId,
      });
      if (signal?.aborted) {
        this.#state = REPAIR_STATES.cancelled;
        return this.#finish({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: REPAIR_STATES.cancelled, repaired: 0, attempt });
      }
      const validation = validateRepair(events, sourceNodeId, fromSourceSequence, toSourceSequence);
      if (!validation.valid) {
        this.#state = REPAIR_STATES.failed;
        return this.#finish({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: REPAIR_STATES.failed, repaired: 0, attempt, error: validation.error });
      }
      const results = this.#transport.ingest(events);
      const rejected = results.filter((result) => !['published', 'duplicate'].includes(result.state));
      if (rejected.length) {
        this.#state = REPAIR_STATES.failed;
        return this.#finish({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: REPAIR_STATES.failed, repaired: 0, rejected: rejected.length, attempt, error: { code: 'REPAIR_INGEST_REJECTED', message: 'one or more repaired events were rejected by the transport' } });
      }
      if (this.#checkpoint && events.length) {
        const last = events[events.length - 1];
        const committed = this.#checkpoint.commit({
          nodeId: this.#transport.snapshot().nodeId ?? 'repair',
          sourceNodeId,
          sourceSequence: last.sourceSequence,
          eventSequence: last.sequence ?? last.sourceSequence,
          fencingToken: Math.max(fencingToken, last.fencingToken ?? 0),
        });
        if (!['committed', 'duplicate'].includes(committed.state)) {
          this.#state = REPAIR_STATES.failed;
          return this.#finish({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: REPAIR_STATES.failed, repaired: 0, attempt, checkpoint: committed.state, error: { code: 'CHECKPOINT_COMMIT_REJECTED', message: 'repair checkpoint advancement was rejected' } });
        }
      }
      this.#state = REPAIR_STATES.succeeded;
      return this.#finish({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: REPAIR_STATES.succeeded, repaired: events.length, rejected: 0, attempt });
    } catch (error) {
      this.#state = signal?.aborted ? REPAIR_STATES.cancelled : REPAIR_STATES.failed;
      return this.#finish({ requestId, sourceNodeId, fromSourceSequence, toSourceSequence, state: this.#state, repaired: 0, attempt, error: normalizeError(error) });
    }
  }

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
function validateFence(value) { if (!Number.isInteger(value) || value < 0) throw new TypeError('fencingToken must be a non-negative integer'); }
function validateRange(from, to) {
  if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < from) throw new TypeError('repair range must contain positive integer sequence bounds');
}
function validateRepair(events, sourceNodeId, from, to) {
  if (!Array.isArray(events)) return { valid: false, error: { code: 'REPAIR_INVALID_RESPONSE', message: 'source repair response must be an array' } };
  if (events.length !== to - from + 1) return { valid: false, error: { code: 'REPAIR_INCOMPLETE_RANGE', message: 'source repair response did not contain the complete requested range' } };
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event || event.sourceNodeId !== sourceNodeId || event.sourceSequence !== from + i) return { valid: false, error: { code: 'REPAIR_NON_CONTIGUOUS_RANGE', message: 'source repair response was not contiguous and complete' } };
  }
  return { valid: true };
}
function normalizeError(error) { return { code: typeof error?.code === 'string' ? error.code : 'OBSERVABILITY_REPAIR_FAILED', message: error instanceof Error ? error.message : String(error) }; }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }

export { SCHEMA_VERSION as OBSERVABILITY_GAP_REPAIR_SCHEMA_VERSION, REPAIR_STATES as OBSERVABILITY_GAP_REPAIR_STATES };
