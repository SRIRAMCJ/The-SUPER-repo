const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['idle', 'failing_over', 'succeeded', 'failed', 'blocked', 'cancelled']);

export class RecoveryFailoverOrchestrator {
  #history = [];
  #inflight = new Map();

  constructor({
    coordinator,
    stateReplicator,
    handoff,
    recoveryLease,
    distributed,
    transport,
    nodeRegistry = distributed,
    nodeHealth = null,
    recoverTransaction,
    ownerId,
    nodeId,
    recoveryCapability = 'runtime.recover.transaction',
    clock = () => new Date(),
    idFactory = defaultId,
    maxHistory = 256,
    staleAfterMs = 300_000
  } = {}) {
    if (!coordinator || typeof coordinator.scan !== 'function') throw new TypeError('coordinator must expose scan()');
    if (!stateReplicator || typeof stateReplicator.append !== 'function' || typeof stateReplicator.list !== 'function') throw new TypeError('stateReplicator must expose append() and list()');
    if (!handoff || typeof handoff.offer !== 'function' || typeof handoff.accept !== 'function' || typeof handoff.beginExecution !== 'function' || typeof handoff.complete !== 'function') throw new TypeError('handoff must expose offer(), accept(), beginExecution() and complete()');
    if (!recoveryLease || typeof recoveryLease.validate !== 'function' || typeof recoveryLease.release !== 'function') throw new TypeError('recoveryLease must expose validate() and release()');
    if (!distributed || typeof distributed.acquireLease !== 'function' || typeof distributed.releaseLease !== 'function') throw new TypeError('distributed must expose acquireLease() and releaseLease()');
    if (!transport || typeof transport.dispatch !== 'function') throw new TypeError('transport must expose dispatch()');
    if (typeof recoverTransaction !== 'function') throw new TypeError('recoverTransaction must be a function');
    if (typeof ownerId !== 'string' || !ownerId || typeof nodeId !== 'string' || !nodeId) throw new TypeError('ownerId and nodeId are required');
    if (!nodeRegistry || typeof nodeRegistry.listNodes !== 'function') throw new TypeError('nodeRegistry must expose listNodes()');
    if (nodeHealth && typeof nodeHealth !== 'function') throw new TypeError('nodeHealth must be a function');
    if (typeof recoveryCapability !== 'string' || !recoveryCapability.trim()) throw new TypeError('recoveryCapability must be a non-empty string');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be positive');
    if (!Number.isInteger(staleAfterMs) || staleAfterMs < 0) throw new TypeError('staleAfterMs must be non-negative');

    Object.assign(this, { coordinator, stateReplicator, handoff, recoveryLease, distributed, transport, nodeRegistry, nodeHealth, recoverTransaction, ownerId, nodeId, recoveryCapability, clock, idFactory, maxHistory, staleAfterMs });
  }

  async recover({ signal = null, force = false, reason = 'automatic_failover' } = {}) {
    if (signal?.aborted) return this.#result('cancelled', [], { code: 'FAILOVER_CANCELLED', message: 'Failover cancelled before scan' });
    const candidates = await this.scan();
    const results = [];
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      if (this.#inflight.has(candidate.transactionId)) {
        results.push(await this.#inflight.get(candidate.transactionId));
        continue;
      }
      const promise = this.failoverOne({ state: candidate, signal, force, reason });
      this.#inflight.set(candidate.transactionId, promise);
      try { results.push(await promise); } finally { this.#inflight.delete(candidate.transactionId); }
    }
    const cancelled = signal?.aborted || results.some((item) => item.status === 'cancelled');
    const blocked = results.some((item) => item.status === 'blocked');
    const failed = results.some((item) => item.status === 'failed');
    return this.#result(cancelled ? 'cancelled' : failed ? 'failed' : blocked ? 'blocked' : 'succeeded', results, cancelled ? { code: 'FAILOVER_CANCELLED', message: 'Failover cancelled' } : null);
  }

  async scan() {
    const states = await this.coordinator.scan();
    const replicated = new Map(this.stateReplicator.list().map((item) => [item.transactionId, item]));
    return Object.freeze(states
      .filter((state) => state.status === 'active' && this.#isStale(state))
      .map((state) => ({ ...clone(state), replicated: clone(replicated.get(state.transactionId) ?? null) })));
  }

  async failoverOne({ state, signal = null, force = false, reason = 'automatic_failover' } = {}) {
    const transactionId = state?.transactionId;
    if (typeof transactionId !== 'string' || !transactionId) throw new TypeError('state.transactionId is required');

    let offered = null;
    let accepted = null;
    let distributedLease = null;
    let targetNodeId = null;
    let requestId = null;
    try {
      if (signal?.aborted) throw cancellation();
      const sourceNodeId = sourceNode(state);
      const replicated = this.stateReplicator.get(transactionId);
      if (replicated && ['succeeded', 'failed', 'cancelled', 'blocked'].includes(replicated.state)) return this.#blocked(transactionId, 'FAILOVER_TERMINAL_STATE', 'Replicated recovery state is already terminal');
      if (!sourceNodeId) return this.#blocked(transactionId, 'FAILOVER_SOURCE_UNKNOWN', 'Source node is not recorded');
      const sourceStatus = await this.#nodeStatus(sourceNodeId);
      if (!force && sourceStatus === 'active') return this.#blocked(transactionId, 'FAILOVER_SOURCE_ACTIVE', 'Source node is still active; refusing automatic failover');
      targetNodeId = await this.selectTarget({ sourceNodeId, transactionId, signal });
      if (!targetNodeId) return this.#blocked(transactionId, 'FAILOVER_TARGET_UNAVAILABLE', 'No eligible target node is available');

      offered = this.handoff.offer({ transactionId, sourceNodeId, targetNodeId, reason, signal });
      await this.replicate(transactionId, 'detected', Math.max(1, this.stateReplicator.get(transactionId)?.fencingToken ?? 1), { requestId: offered.handoffId, reason, sourceNodeId, targetNodeId });
      accepted = await this.handoff.accept({ transactionId, targetNodeId, ownerId: this.ownerId, signal });
      await this.replicate(transactionId, 'leased', accepted.handoff.fencingToken, { requestId: offered.handoffId, reason, sourceNodeId, targetNodeId });

      distributedLease = await this.distributed.acquireLease({ executionId: transactionId, nodeId: targetNodeId });
      this.handoff.beginExecution({ transactionId, targetNodeId, fencingToken: accepted.handoff.fencingToken, signal });
      await this.replicate(transactionId, 'recovering', accepted.handoff.fencingToken, { requestId: offered.handoffId, reason, sourceNodeId, targetNodeId });

      requestId = this.idFactory('failover-request');
      const remote = await this.transport.dispatch({
        requestId,
        executionId: transactionId,
        nodeId: targetNodeId,
        fencingToken: distributedLease.fencingToken,
        idempotencyKey: 'failover:' + transactionId + ':' + accepted.handoff.fencingToken,
        capability: { id: this.recoveryCapability },
        input: {
          transactionId, force, reason, sourceNodeId, targetNodeId,
          recoveryOwnerId: this.ownerId, recoveryNodeId: targetNodeId,
          handoffFencingToken: accepted.handoff.fencingToken,
          distributedFencingToken: distributedLease.fencingToken
        },
        signal,
        handler: async ({ signal: childSignal, fencingToken }) => {
          this.recoveryLease.validate({ executionId: transactionId, ownerId: this.ownerId, nodeId: targetNodeId, fencingToken: accepted.handoff.fencingToken });
          this.distributed.validateLease({ executionId: transactionId, nodeId: targetNodeId, fencingToken });
          const recovered = await this.recoverTransaction(transactionId, {
            signal: childSignal, force, reason, sourceNodeId, targetNodeId,
            recoveryOwnerId: this.ownerId, recoveryNodeId: targetNodeId,
            handoffFencingToken: accepted.handoff.fencingToken,
            distributedFencingToken: fencingToken
          });
          this.recoveryLease.validate({ executionId: transactionId, ownerId: this.ownerId, nodeId: targetNodeId, fencingToken: accepted.handoff.fencingToken });
          this.distributed.validateLease({ executionId: transactionId, nodeId: targetNodeId, fencingToken });
          return recovered;
        }
      });

      const status = signal?.aborted ? 'cancelled' : normalizeRemoteStatus(remote.status);
      this.handoff.complete({ transactionId, targetNodeId, fencingToken: accepted.handoff.fencingToken, status, result: remote.result ?? null });
      await this.replicate(transactionId, status, accepted.handoff.fencingToken, {
        requestId, reason, sourceNodeId, targetNodeId, result: remote.result ?? null, error: remote.error ?? null
      });
      const outcome = { transactionId, sourceNodeId, targetNodeId, requestId, handoffId: offered.handoffId, fencingToken: accepted.handoff.fencingToken, distributedFencingToken: distributedLease.fencingToken, status, result: remote.result ?? null, error: remote.error ?? null };
      this.#record('failover_completed', outcome);
      return freeze(outcome);
    } catch (error) {
      const normalized = normalizeError(error, 'FAILOVER_FAILED');
      const status = isCancellation(error, signal) ? 'cancelled' : normalized.code === 'RECOVERY_LEASE_HELD' || normalized.code === 'LEASE_HELD' || normalized.code === 'FAILOVER_TARGET_UNAVAILABLE' ? 'blocked' : 'failed';
      if (accepted && offered) {
        try { this.handoff.cancel({ transactionId, targetNodeId, fencingToken: accepted.handoff.fencingToken, reason: normalized.code }); } catch {}
      }
      if (accepted) {
        try { await this.replicate(transactionId, status, accepted.handoff.fencingToken, { requestId, reason, error: normalized, targetNodeId }); } catch {}
      }
      const outcome = { transactionId, sourceNodeId: sourceNode(state), targetNodeId, requestId, handoffId: offered?.handoffId ?? null, fencingToken: accepted?.handoff.fencingToken ?? null, status, error: normalized };
      this.#record('failover_failed', outcome);
      return freeze(outcome);
    } finally {
      if (distributedLease) {
        try { await this.distributed.releaseLease({ executionId: transactionId, nodeId: targetNodeId, fencingToken: distributedLease.fencingToken }); }
        catch (error) { this.#record('distributed_lease_release_failed', { transactionId, error: normalizeError(error, 'DISTRIBUTED_LEASE_RELEASE_FAILED') }); }
      }
      if (accepted) {
        try { await this.recoveryLease.release({ executionId: transactionId, ownerId: this.ownerId, nodeId: targetNodeId, fencingToken: accepted.handoff.fencingToken }); }
        catch (error) { this.#record('recovery_lease_release_failed', { transactionId, error: normalizeError(error, 'RECOVERY_LEASE_RELEASE_FAILED') }); }
      }
    }
  }

  async selectTarget({ sourceNodeId, transactionId, signal = null } = {}) {
    if (signal?.aborted) throw cancellation();
    const nodes = this.nodeRegistry.listNodes();
    const candidates = [];
    for (const node of nodes) {
      if (node.nodeId === sourceNodeId || node.state !== 'active') continue;
      if (!node.capabilities.includes(this.recoveryCapability)) continue;
      const health = await this.#nodeStatus(node.nodeId);
      if (health === 'unhealthy' || health === 'draining' || health === 'failed' || health === 'unavailable') continue;
      candidates.push(node);
    }
    candidates.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    return candidates[0]?.nodeId ?? null;
  }

  async replicate(transactionId, state, fencingToken, details = {}) {
    const current = this.stateReplicator.get(transactionId);
    const sequence = (current?.sequence ?? 0) + 1;
    return this.stateReplicator.append({
      transactionId, sequence, state,
      ownerId: this.ownerId, nodeId: this.nodeId, fencingToken,
      recoveryId: details.requestId ?? null, requestId: details.requestId ?? null,
      reason: details.reason ?? null, result: details.result ?? null, error: details.error ?? null,
      sourceNodeId: details.sourceNodeId ?? null, targetNodeId: details.targetNodeId ?? null
    });
  }

  async #nodeStatus(nodeId) {
    if (this.nodeHealth) {
      try {
        const value = await this.nodeHealth(nodeId);
        if (typeof value === 'string') return value.toLowerCase();
        return String(value?.state ?? value?.status ?? 'unknown').toLowerCase();
      } catch { return 'unhealthy'; }
    }
    const node = this.nodeRegistry.listNodes().find((item) => item.nodeId === nodeId);
    return node?.state ?? 'unknown';
  }

  #blocked(transactionId, code, message) {
    const outcome = { transactionId, status: 'blocked', error: { code, message, retryable: code === 'FAILOVER_TARGET_UNAVAILABLE' } };
    this.#record('failover_blocked', outcome);
    return freeze(outcome);
  }

  #isStale(state) {
    const timestamp = Date.parse(state.updatedAt ?? state.timestamp ?? '');
    return Number.isFinite(timestamp) && this.clock().getTime() - timestamp >= this.staleAfterMs;
  }

  #result(status, results, error = null) {
    const result = freeze({
      schemaVersion: SCHEMA_VERSION, type: 'recovery-failover-result',
      failoverId: this.idFactory('recovery-failover'), ownerId: this.ownerId, nodeId: this.nodeId,
      status, results, error, completedAt: this.nowIso()
    });
    this.#record('failover_run', result);
    return result;
  }

  #record(event, data) {
    this.#history.push(freeze({
      schemaVersion: SCHEMA_VERSION, eventId: this.idFactory('recovery-failover-event'),
      event, timestamp: this.nowIso(), data: clone(data)
    }));
    while (this.#history.length > this.maxHistory) this.#history.shift();
  }

  history() { return deepFreeze(this.#history.map(clone)); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, type: 'recovery-failover-orchestrator', ownerId: this.ownerId, nodeId: this.nodeId, history: this.history() }); }
  nowIso() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date'); return value.toISOString(); }
}

function sourceNode(state) { return state.recoveryNodeId ?? state.nodeId ?? state.ownerNodeId ?? null; }
function normalizeRemoteStatus(status) { return status === 'succeeded' ? 'succeeded' : status === 'cancelled' || status === 'timed_out' ? 'cancelled' : 'failed'; }
function isCancellation(error, signal) { return signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'CANCELLED' || error?.code === 'FAILOVER_CANCELLED'; }
function cancellation() { return Object.assign(new Error('Failover cancelled'), { code: 'FAILOVER_CANCELLED', retryable: false }); }
function normalizeError(error, fallbackCode) { return { code: error?.code ?? fallbackCode, message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function clone(value) { return value == null ? value : structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function defaultId(prefix) { return prefix + '-' + Date.now().toString(36); }

export { SCHEMA_VERSION as RECOVERY_FAILOVER_SCHEMA_VERSION, STATES as RECOVERY_FAILOVER_STATES };
