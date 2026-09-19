const SCHEMA_VERSION = '0.2.0';
import { ObservabilityIntegrityKernel } from './observability-integrity.js';
const CONVERGENCE_STATES = Object.freeze({
  idle: 'idle',
  reconciling: 'reconciling',
  converged: 'converged',
  divergent: 'divergent',
  blocked: 'blocked',
  failed: 'failed',
  cancelled: 'cancelled',
});

export class ObservabilityConvergenceKernel {
  #local;
  #remote;
  #clock;
  #idFactory;
  #maxHistory;
  #history = [];
  #inflight = new Map();
  #state = CONVERGENCE_STATES.idle;
  #integrity;

  constructor({ local, remote, integrity = ObservabilityIntegrityKernel, clock = () => new Date(), idFactory = () => globalThis.crypto.randomUUID(), maxHistory = 1_000 } = {}) {
    if (!local || typeof local.snapshot !== 'function') throw new TypeError('local must expose snapshot()');
    if (!remote || typeof remote.inspect !== 'function') throw new TypeError('remote must expose inspect()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    if (!integrity || typeof integrity.verifyRange !== 'function') throw new TypeError('integrity must expose verifyRange()');
    this.#local = local;
    this.#integrity = integrity;
    this.#remote = remote;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#maxHistory = maxHistory;
  }

  async reconcile({ sourceNodeId, signal, force = false } = {}) {
    validateNode(sourceNodeId);
    const key = sourceNodeId;
    if (this.#inflight.has(key)) return this.#inflight.get(key);
    const operation = this.#run({ sourceNodeId, signal, force });
    this.#inflight.set(key, operation);
    try { return await operation; } finally { this.#inflight.delete(key); }
  }

  status() {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'observability-convergence-kernel',
      state: this.#state,
      inFlight: this.#inflight.size,
      history: this.#history,
    });
  }

  history() { return freeze(this.#history); }

  async #run({ sourceNodeId, signal, force }) {
    const requestId = this.#idFactory();
    this.#state = CONVERGENCE_STATES.reconciling;
    this.#record({ requestId, sourceNodeId, state: this.#state });
    try {
      if (signal?.aborted) return this.#finish({ requestId, sourceNodeId, state: CONVERGENCE_STATES.cancelled });
      const remote = await this.#remote.inspect({ sourceNodeId, signal });
      if (signal?.aborted) return this.#finish({ requestId, sourceNodeId, state: CONVERGENCE_STATES.cancelled });
      const local = this.#local.snapshot();
      const comparison = compareSnapshots(local, remote, sourceNodeId);
      if (comparison.state === 'converged') {
        if (comparison.digest && remote.digest && comparison.digest !== remote.digest) {
          this.#state = CONVERGENCE_STATES.divergent;
          return this.#finish({ requestId, sourceNodeId, state: this.#state, comparison: { ...comparison, reason: 'DIGEST_DIVERGENCE' } });
        }
        this.#state = CONVERGENCE_STATES.converged;
        return this.#finish({ requestId, sourceNodeId, state: this.#state, comparison });
      }
      if (!force && comparison.state === 'blocked') {
        this.#state = CONVERGENCE_STATES.blocked;
        return this.#finish({ requestId, sourceNodeId, state: this.#state, comparison });
      }
      if (typeof this.#remote.repair !== 'function') {
        this.#state = CONVERGENCE_STATES.failed;
        return this.#finish({ requestId, sourceNodeId, state: this.#state, comparison, error: { code: 'REPAIR_UNAVAILABLE', message: 'remote repair is required for divergent state' } });
      }\n      const repair = await this.#remote.repair({
        sourceNodeId,
        fromSourceSequence: comparison.fromSourceSequence,
        toSourceSequence: comparison.toSourceSequence,
        expectedDigest: comparison.expectedDigest,
        integrity: this.#integrity,
        signal,
        requestId,
      });
      if (signal?.aborted) return this.#finish({ requestId, sourceNodeId, state: CONVERGENCE_STATES.cancelled, repair });
      if (!repair || !['succeeded', 'converged'].includes(repair.state)) {
        this.#state = CONVERGENCE_STATES.failed;
        return this.#finish({ requestId, sourceNodeId, state: this.#state, comparison, repair, error: { code: 'OBSERVABILITY_REPAIR_FAILED', message: 'remote repair did not reach a terminal success state' } });
      }
      const after = await this.#remote.inspect({ sourceNodeId, signal });
      const finalLocal = this.#local.snapshot();
      const finalComparison = compareSnapshots(finalLocal, after, sourceNodeId);
      if (finalComparison.state === 'converged' && finalComparison.expectedDigest) {
        const verified = await this.#remote.verifyDigest?.({ sourceNodeId, expectedDigest: finalComparison.expectedDigest, signal }) ?? { valid: true };
        if (!verified.valid) {
          finalComparison.state = 'divergent';
          finalComparison.reason = 'DIGEST_VERIFICATION_FAILED';
        }
      }
      this.#state = finalComparison.state === 'converged' ? CONVERGENCE_STATES.converged : CONVERGENCE_STATES.divergent;
      return this.#finish({ requestId, sourceNodeId, state: this.#state, comparison: finalComparison, repair });
    } catch (error) {
      this.#state = signal?.aborted ? CONVERGENCE_STATES.cancelled : CONVERGENCE_STATES.failed;
      return this.#finish({ requestId, sourceNodeId, state: this.#state, error: normalizeError(error) });
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

function compareSnapshots(local, remote, sourceNodeId) {
  const localCheckpoint = local?.checkpoint?.checkpoints ?? local?.checkpoints ?? {};
  const remoteCheckpoint = remote?.checkpoint?.checkpoints ?? remote?.checkpoints ?? {};
  const localValue = localCheckpoint[sourceNodeId] ?? localCheckpoint[remote.sourceNodeId] ?? localCheckpoint[remote.nodeId] ?? null;
  const remoteValue = remoteCheckpoint[sourceNodeId] ?? remoteCheckpoint[remote.sourceNodeId] ?? remoteCheckpoint[remote.nodeId] ?? remote.checkpoint ?? null;
  if (!localValue || !remoteValue) {
    return { state: 'blocked', reason: 'CHECKPOINT_MISSING', fromSourceSequence: 1, toSourceSequence: 0 };
  }
  if (localValue.fencingToken !== remoteValue.fencingToken) {
    return { state: 'blocked', reason: 'FENCING_DIVERGENCE', localFencingToken: localValue.fencingToken, remoteFencingToken: remoteValue.fencingToken, fromSourceSequence: 1, toSourceSequence: 0 };
  }
  if (localValue.sourceSequence === remoteValue.sourceSequence && localValue.eventSequence === remoteValue.eventSequence) {
    return { state: 'converged', sourceSequence: localValue.sourceSequence, eventSequence: localValue.eventSequence, fencingToken: localValue.fencingToken, digest: localValue.digest ?? null, expectedDigest: remoteValue.digest ?? null };
  }
  const from = Math.min(localValue.sourceSequence, remoteValue.sourceSequence) + 1;
  const to = Math.max(localValue.sourceSequence, remoteValue.sourceSequence);
  return {
    state: 'divergent',
    localSourceSequence: localValue.sourceSequence,
    remoteSourceSequence: remoteValue.sourceSequence,
    fromSourceSequence: from,
    toSourceSequence: to,
    expectedDigest: remoteValue.digest ?? null,
    digest: localValue.digest ?? null,
  };
}
function validateNode(value) { if (typeof value !== 'string' || !value.trim()) throw new TypeError('sourceNodeId must be a non-empty string'); }
function normalizeError(error) { return { code: typeof error?.code === 'string' ? error.code : 'OBSERVABILITY_CONVERGENCE_FAILED', message: error instanceof Error ? error.message : String(error) }; }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }

export { SCHEMA_VERSION as OBSERVABILITY_CONVERGENCE_SCHEMA_VERSION, CONVERGENCE_STATES as OBSERVABILITY_CONVERGENCE_STATES };
