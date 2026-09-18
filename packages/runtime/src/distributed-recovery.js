const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['idle', 'recovering', 'succeeded', 'failed', 'blocked']);

export class DistributedTransactionRecovery {
  #history = [];
  #inflight = new Map();
  #sequences = new Map();

  constructor({ coordinator, lease, distributed, stateReplicator = null, ownerId, nodeId, clock = () => new Date(), idFactory = defaultId, maxHistory = 256 } = {}) {
    if (!coordinator || typeof coordinator.scan !== 'function') throw new TypeError('coordinator must expose scan()');
    if (!lease || typeof lease.acquire !== 'function' || typeof lease.release !== 'function') throw new TypeError('lease must expose acquire() and release()');
    if (!distributed || typeof distributed.execute !== 'function') throw new TypeError('distributed must expose execute()');
    if (stateReplicator && (typeof stateReplicator.append !== 'function' || typeof stateReplicator.get !== 'function')) throw new TypeError('stateReplicator must expose append() and get()');
    if (typeof ownerId !== 'string' || !ownerId || typeof nodeId !== 'string' || !nodeId) throw new TypeError('ownerId and nodeId are required');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be positive');
    this.coordinator = coordinator; this.lease = lease; this.distributed = distributed; this.stateReplicator = stateReplicator;
    this.ownerId = ownerId; this.nodeId = nodeId; this.clock = clock; this.idFactory = idFactory; this.maxHistory = maxHistory;
  }

  async recover({ signal = null, force = false, reason = 'distributed_restart' } = {}) {
    if (signal?.aborted) return this.result('blocked', [], { code: 'DISTRIBUTED_RECOVERY_CANCELLED', message: 'Recovery cancelled before scan' });
    const candidates = await this.coordinator.scan();
    const results = [];
    for (const state of candidates) {
      if (signal?.aborted) break;
      const transactionId = state.transactionId;
      if (this.#inflight.has(transactionId)) { results.push(await this.#inflight.get(transactionId)); continue; }
      const promise = this.recoverOne({ state, signal, force, reason });
      this.#inflight.set(transactionId, promise);
      try { results.push(await promise); } finally { this.#inflight.delete(transactionId); }
    }
    const cancelled = signal?.aborted || results.some(x => x.status === 'cancelled');
    const failed = results.some(x => x.status === 'failed' || x.status === 'blocked');
    return this.result(cancelled ? 'blocked' : failed ? 'failed' : 'succeeded', results, cancelled ? { code: 'DISTRIBUTED_RECOVERY_CANCELLED', message: 'Recovery cancelled' } : null);
  }

  async recoverOne({ state, signal, force, reason }) {
    const transactionId = state.transactionId;
    let lease = null;
    let requestId = null;
    try {
      lease = await this.lease.acquire({ executionId: transactionId, ownerId: this.ownerId, nodeId: this.nodeId, signal, reason });
      requestId = this.idFactory('distributed-recovery-request');
      await this.replicate(transactionId, 'leased', lease.fencingToken, { requestId, reason });
      await this.replicate(transactionId, 'recovering', lease.fencingToken, { requestId, reason });
      const result = await this.distributed.execute({
        executionId: transactionId, nodeId: this.nodeId, fencingToken: lease.fencingToken,
        idempotencyKey: 'recovery:' + transactionId + ':' + lease.fencingToken,
        capability: { id: 'runtime.recover.transaction' },
        input: { transactionId, force, reason, recoveryOwnerId: this.ownerId, recoveryNodeId: this.nodeId, fencingToken: lease.fencingToken },
        signal,
        handler: async ({ signal: childSignal, fencingToken }) => {
          this.lease.validate({ executionId: transactionId, ownerId: this.ownerId, nodeId: this.nodeId, fencingToken });
          if (!this.coordinator.transaction || typeof this.coordinator.transaction.recover !== 'function') throw Object.assign(new Error('Coordinator transaction recovery is unavailable'), { code: 'TRANSACTION_RECOVERY_UNAVAILABLE', retryable: false });
          const recovered = await this.coordinator.transaction.recover(transactionId, { signal: childSignal, force, fencingToken, recoveryOwnerId: this.ownerId, recoveryNodeId: this.nodeId });
          this.lease.validate({ executionId: transactionId, ownerId: this.ownerId, nodeId: this.nodeId, fencingToken });
          return recovered;
        }
      });
      const status = normalizeStatus(result.status);
      const outcome = { transactionId, requestId, fencingToken: lease.fencingToken, status, result: result.result, error: result.error ?? null };
      await this.replicate(transactionId, status, lease.fencingToken, { requestId, result: result.result, error: result.error ?? null, reason });
      this.#record('recovery_completed', outcome); return outcome;
    } catch (error) {
      const normalized = normalizeError(error, 'DISTRIBUTED_RECOVERY_FAILED');
      const status = isCancellation(error, signal) ? 'cancelled' : normalized.code === 'RECOVERY_LEASE_HELD' ? 'blocked' : 'failed';
      const outcome = { transactionId, requestId, fencingToken: lease?.fencingToken ?? null, status, error: normalized };
      if (lease?.fencingToken) {
        try { await this.replicate(transactionId, status, lease.fencingToken, { requestId, error: normalized, reason }); }
        catch (replicationError) { outcome.replicationError = normalizeError(replicationError, 'RECOVERY_STATE_REPLICATION_FAILED'); }
      }
      this.#record('recovery_failed', outcome); return outcome;
    } finally {
      if (lease) {
        try { await this.lease.release({ executionId: transactionId, ownerId: this.ownerId, nodeId: this.nodeId, fencingToken: lease.fencingToken }); }
        catch (error) { this.#record('lease_release_failed', { transactionId, error: normalizeError(error, 'RECOVERY_LEASE_RELEASE_FAILED') }); }
      }
    }
  }

  async replicate(transactionId, state, fencingToken, { requestId = null, result = null, error = null, reason = null } = {}) {
    if (!this.stateReplicator) return null;
    const current = this.stateReplicator.get(transactionId);
    const sequence = Math.max(this.#sequences.get(transactionId) ?? 0, current?.sequence ?? 0) + 1;
    this.#sequences.set(transactionId, sequence);
    return this.stateReplicator.append({ transactionId, sequence, state, ownerId: this.ownerId, nodeId: this.nodeId, fencingToken, recoveryId: requestId, requestId, result, error, reason });
  }

  history() { return Object.freeze(this.#history.map(clone)); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, type: 'distributed-transaction-recovery', ownerId: this.ownerId, nodeId: this.nodeId, history: this.history() }); }
  result(status, results, error) { const value = freeze({ schemaVersion: SCHEMA_VERSION, type: 'distributed-recovery-result', recoveryId: this.idFactory('distributed-recovery'), status, results, error, completedAt: this.nowIso() }); this.#record('recovery_run', value); return value; }
  #record(event, data) { this.#history.push(freeze({ schemaVersion: SCHEMA_VERSION, eventId: this.idFactory('distributed-recovery-event'), event, timestamp: this.nowIso(), ...clone(data) })); while (this.#history.length > this.maxHistory) this.#history.shift(); }
  nowIso() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return valid Date'); return value.toISOString(); }
}

function normalizeStatus(status) {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'cancelled' || status === 'timed_out') return 'cancelled';
  if (status === 'blocked') return 'blocked';
  return 'failed';
}
function isCancellation(error, signal) { return signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'CANCELLED'; }
function normalizeError(error, fallbackCode) { return { code: error?.code ?? fallbackCode, message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function clone(value) { return value == null ? value : structuredClone(value); }
function defaultId(prefix) { return prefix + '-' + Date.now().toString(36); }
export { SCHEMA_VERSION as DISTRIBUTED_TRANSACTION_RECOVERY_SCHEMA_VERSION, STATES as DISTRIBUTED_TRANSACTION_RECOVERY_STATES };
