const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['idle', 'recovering', 'succeeded', 'failed', 'blocked']);

export class DistributedTransactionRecovery {
  #history = [];
  #inflight = new Map();

  constructor({ coordinator, lease, distributed, ownerId, nodeId, clock = () => new Date(), idFactory = defaultId, maxHistory = 256 } = {}) {
    if (!coordinator || typeof coordinator.scan !== 'function') throw new TypeError('coordinator must expose scan()');
    if (!lease || typeof lease.acquire !== 'function' || typeof lease.release !== 'function') throw new TypeError('lease must expose acquire() and release()');
    if (!distributed || typeof distributed.execute !== 'function') throw new TypeError('distributed must expose execute()');
    if (typeof ownerId !== 'string' || !ownerId || typeof nodeId !== 'string' || !nodeId) throw new TypeError('ownerId and nodeId are required');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be positive');
    this.coordinator = coordinator; this.lease = lease; this.distributed = distributed; this.ownerId = ownerId; this.nodeId = nodeId;
    this.clock = clock; this.idFactory = idFactory; this.maxHistory = maxHistory;
  }

  async recover({ signal = null, force = false, reason = 'distributed_restart' } = {}) {
    if (signal?.aborted) return this.result('blocked', [], { code: 'DISTRIBUTED_RECOVERY_CANCELLED', message: 'Recovery cancelled before scan' });
    const candidates = await this.coordinator.scan();
    const results = [];
    for (const state of candidates) {
      if (signal?.aborted) break;
      const transactionId = state.transactionId;
      if (this.#inflight.has(transactionId)) { results.push(this.#inflight.get(transactionId)); continue; }
      const promise = this.recoverOne({ state, signal, force, reason });
      this.#inflight.set(transactionId, promise);
      try { results.push(await promise); } finally { this.#inflight.delete(transactionId); }
    }
    return this.result(signal?.aborted ? 'blocked' : results.some(x => x.status === 'failed' || x.status === 'blocked') ? 'failed' : 'succeeded', results, signal?.aborted ? { code: 'DISTRIBUTED_RECOVERY_CANCELLED', message: 'Recovery cancelled' } : null);
  }

  async recoverOne({ state, signal, force, reason }) {
    const transactionId = state.transactionId;
    let lease = null;
    try {
      lease = this.lease.acquire({ executionId: transactionId, ownerId: this.ownerId, nodeId: this.nodeId, signal, reason });
      const requestId = this.idFactory('distributed-recovery-request');
      const result = await this.distributed.execute({
        executionId: transactionId, nodeId: this.nodeId, fencingToken: lease.fencingToken,
        idempotencyKey: 'recovery:' + transactionId + ':' + lease.fencingToken,
        capability: { id: 'runtime.recover.transaction' },
        input: { transactionId, force, reason, recoveryOwnerId: this.ownerId, recoveryNodeId: this.nodeId, fencingToken: lease.fencingToken },
        signal,
        handler: async ({ signal: childSignal, fencingToken }) => {
          this.lease.validate({ executionId: transactionId, ownerId: this.ownerId, nodeId: this.nodeId, fencingToken });
          const recovered = await this.coordinator.transaction.recover(transactionId, { signal: childSignal, force, fencingToken, recoveryOwnerId: this.ownerId, recoveryNodeId: this.nodeId });
          this.lease.validate({ executionId: transactionId, ownerId: this.ownerId, nodeId: this.nodeId, fencingToken });
          return recovered;
        }
      });
      const outcome = { transactionId, requestId, fencingToken: lease.fencingToken, status: result.status, result: result.result, error: result.error ?? null };
      this.#record('recovery_completed', outcome); return outcome;
    } catch (error) {
      const outcome = { transactionId, status: 'failed', error: normalizeError(error, 'DISTRIBUTED_RECOVERY_FAILED') };
      this.#record('recovery_failed', outcome); return outcome;
    } finally {
      if (lease) {
        try { this.lease.release({ executionId: transactionId, ownerId: this.ownerId, nodeId: this.nodeId, fencingToken: lease.fencingToken }); }
        catch (error) { this.#record('lease_release_failed', { transactionId, error: normalizeError(error, 'RECOVERY_LEASE_RELEASE_FAILED') }); }
      }
    }
  }

  history() { return Object.freeze(this.#history.map(clone)); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, type: 'distributed-transaction-recovery', ownerId: this.ownerId, nodeId: this.nodeId, history: this.history() }); }
  result(status, results, error) { const value = freeze({ schemaVersion: SCHEMA_VERSION, type: 'distributed-recovery-result', recoveryId: this.idFactory('distributed-recovery'), status, results, error, completedAt: this.nowIso() }); this.#record('recovery_run', value); return value; }
  #record(event, data) { this.#history.push(freeze({ schemaVersion: SCHEMA_VERSION, eventId: this.idFactory('distributed-recovery-event'), event, timestamp: this.nowIso(), ...clone(data) })); while (this.#history.length > this.maxHistory) this.#history.shift(); }
  nowIso() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return valid Date'); return value.toISOString(); }
}

function normalizeError(error, fallbackCode) { return { code: error?.code ?? fallbackCode, message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function clone(value) { return value == null ? value : structuredClone(value); }
function defaultId(prefix) { return prefix + '-' + Date.now().toString(36); }
export { SCHEMA_VERSION as DISTRIBUTED_TRANSACTION_RECOVERY_SCHEMA_VERSION, STATES as DISTRIBUTED_TRANSACTION_RECOVERY_STATES };
