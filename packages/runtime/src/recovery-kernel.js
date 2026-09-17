const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['idle', 'recovering', 'succeeded', 'failed', 'cancelled']);

export class RuntimeRecoveryKernel {
  #active = null;
  #history = [];

  constructor({ lifecycle, shutdown, readiness = null, resources = null, clock = () => new Date(), idFactory = defaultId, maxHistory = 128 } = {}) {
    if (!lifecycle || typeof lifecycle.start !== 'function' || typeof lifecycle.stop !== 'function' || typeof lifecycle.snapshot !== 'function') throw new TypeError('lifecycle must expose start(), stop(), and snapshot()');
    if (!shutdown || typeof shutdown.beginDrain !== 'function' || typeof shutdown.waitForDrain !== 'function' || typeof shutdown.forceStop !== 'function' || typeof shutdown.reopen !== 'function') throw new TypeError('shutdown must expose beginDrain(), waitForDrain(), forceStop(), and reopen()');
    if (readiness && typeof readiness.evaluate !== 'function') throw new TypeError('readiness must expose evaluate()');
    if (resources && typeof resources.snapshot !== 'function') throw new TypeError('resources must expose snapshot()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.lifecycle = lifecycle;
    this.shutdown = shutdown;
    this.readiness = readiness;
    this.resources = resources;
    this.clock = clock;
    this.idFactory = idFactory;
    this.maxHistory = maxHistory;
  }

  async recover({ reason = 'restart', deadlineMs = 30_000, pollMs = 10, signal, readinessCorrelationId } = {}) {
    if (this.#active) throw recoveryError('RECOVERY_IN_PROGRESS', `Recovery already active: ${this.#active.recoveryId}`, true);
    if (!Number.isInteger(deadlineMs) || deadlineMs < 0) throw recoveryError('DEADLINE_INVALID', 'deadlineMs must be a non-negative integer');
    if (!Number.isInteger(pollMs) || pollMs < 0) throw recoveryError('POLL_INTERVAL_INVALID', 'pollMs must be a non-negative integer');
    if (signal?.aborted) return this.#finishCancelled(null, 'aborted_before_start');

    const recovery = { recoveryId: this.idFactory('recovery'), reason: sanitizeReason(reason), startedAt: this.nowIso(), status: 'recovering' };
    this.#active = freeze(recovery);
    this.#record({ ...recovery, event: 'started' });

    try {
      this.#assertNotCancelled(signal);
      const admission = this.shutdown.beginDrain({ deadlineMs, reason: `recovery:${recovery.reason}` });
      let drain = null;
      let forced = false;
      try {
        drain = await this.shutdown.waitForDrain({ deadlineMs, pollMs, signal });
      } catch (error) {
        if (error?.code === 'DRAIN_CANCELLED' || signal?.aborted) throw recoveryError('RECOVERY_CANCELLED', 'Recovery drain was cancelled', true);
        if (error?.code !== 'DRAIN_DEADLINE_EXCEEDED') throw error;
        forced = true;
        drain = this.shutdown.forceStop({ reason: 'recovery_deadline' });
      }

      this.#assertNotCancelled(signal);
      const lifecycleBefore = clone(this.lifecycle.snapshot());
      if (lifecycleBefore.state !== 'stopped') await this.lifecycle.stop();
      this.#assertNotCancelled(signal);
      await this.lifecycle.start();
      this.#assertNotCancelled(signal);
      let readiness = null;
      if (this.readiness) {
        readiness = await this.readiness.evaluate({ correlationId: readinessCorrelationId ?? recovery.recoveryId, signal });
        if (readiness.state === 'failed' || readiness.state === 'degraded') throw recoveryError('READINESS_FAILED', `Runtime readiness is ${readiness.state}`, true);
      }
      const reopened = this.shutdown.reopen({ reason: 'recovery_complete' });
      const result = freeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-recovery-result', recoveryId: recovery.recoveryId, status: 'succeeded', forced, admission: clone(admission), drain: clone(drain), lifecycle: clone(this.lifecycle.snapshot()), readiness, shutdown: clone(reopened), resources: this.resources?.snapshot?.() ?? null, completedAt: this.nowIso() });
      this.#record({ ...result, event: 'completed' });
      this.#active = null;
      return result;
    } catch (error) {
      const cancelled = error?.code === 'RECOVERY_CANCELLED' || signal?.aborted;
      const normalized = normalizeError(error, cancelled ? 'RECOVERY_CANCELLED' : 'RECOVERY_FAILED');
      const result = freeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-recovery-result', recoveryId: recovery.recoveryId, status: cancelled ? 'cancelled' : 'failed', error: normalized, lifecycle: clone(this.lifecycle.snapshot()), shutdown: clone(this.shutdown.snapshot()), resources: this.resources?.snapshot?.() ?? null, completedAt: this.nowIso() });
      this.#record({ ...result, event: cancelled ? 'cancelled' : 'failed' });
      this.#active = null;
      if (cancelled) return result;
      throw Object.assign(new Error(normalized.message), { code: normalized.code, retryable: normalized.retryable, recovery: result });
    }
  }

  state() { return this.#active ? 'recovering' : (this.#history.at(-1)?.status ?? 'idle'); }
  activeRecovery() { return clone(this.#active); }
  history() { return Object.freeze(this.#history.map(clone)); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, state: this.state(), activeRecovery: this.#active, history: this.#history, lifecycle: clone(this.lifecycle.snapshot()), shutdown: clone(this.shutdown.snapshot()), resources: this.resources?.snapshot?.() ?? null }); }

  #assertNotCancelled(signal) { if (signal?.aborted) throw recoveryError('RECOVERY_CANCELLED', 'Recovery was cancelled', true); }
  #finishCancelled(recoveryId, reason) {
    const result = freeze({ schemaVersion: SCHEMA_VERSION, type: 'runtime-recovery-result', recoveryId, status: 'cancelled', error: { code: 'RECOVERY_CANCELLED', message: reason, retryable: true }, completedAt: this.nowIso() });
    this.#record({ ...result, event: 'cancelled' });
    return result;
  }
  #record(value) {
    this.#history.push(freeze({ schemaVersion: SCHEMA_VERSION, id: this.idFactory('recovery-event'), timestamp: this.nowIso(), ...value }));
    while (this.#history.length > this.maxHistory) this.#history.shift();
  }
  nowIso() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date'); return value.toISOString(); }
}

function sanitizeReason(value) { return typeof value === 'string' && value.trim() ? value.trim() : 'unspecified'; }
function normalizeError(error, fallbackCode) { return { code: error?.code ?? fallbackCode, message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function recoveryError(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function clone(value) { return value === undefined || value === null ? value : structuredClone(value); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function defaultId(prefix = 'recovery') { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as RUNTIME_RECOVERY_SCHEMA_VERSION, STATES as RUNTIME_RECOVERY_STATES };