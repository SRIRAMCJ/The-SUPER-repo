const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['accepting', 'draining', 'stopped']);

export class RuntimeShutdownAdmission {
  #active = new Map();
  #state = 'accepting';
  #history = [];

  constructor({ clock = () => Date.now(), idFactory = () => crypto.randomUUID(), historyLimit = 128 } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new TypeError('historyLimit must be a positive integer');
    this.clock = clock;
    this.idFactory = idFactory;
    this.historyLimit = historyLimit;
  }

  state() { return this.#state; }

  admit({ executionId = this.idFactory('execution'), metadata = {} } = {}) {
    if (typeof executionId !== 'string' || executionId.length === 0) throw shutdownError('EXECUTION_ID_INVALID', 'executionId is required');
    if (this.#state !== 'accepting') throw shutdownError('ADMISSION_CLOSED', `Runtime is ${this.#state}`, true);
    if (this.#active.has(executionId)) throw shutdownError('EXECUTION_ALREADY_ADMITTED', `Execution is already admitted: ${executionId}`);
    const lease = freeze({
      schemaVersion: SCHEMA_VERSION,
      admissionId: this.idFactory('admission'),
      executionId,
      admittedAt: this.clock(),
      metadata: sanitize(metadata),
    });
    this.#active.set(executionId, lease);
    return clone(lease);
  }

  release(executionId, { reason = 'completed' } = {}) {
    if (!this.#active.has(executionId)) return false;
    this.#active.delete(executionId);
    this.#record('released', executionId, { reason: sanitizeReason(reason) });
    return true;
  }

  beginDrain({ deadlineMs = 30_000, reason = 'shutdown' } = {}) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 0) throw shutdownError('DEADLINE_INVALID', 'deadlineMs must be a non-negative integer');
    if (this.#state === 'stopped') return this.snapshot();
    if (this.#state === 'draining') return this.snapshot();
    const now = this.clock();
    this.#state = 'draining';
    this.#record('draining', null, {
      reason: sanitizeReason(reason),
      deadlineAt: now + deadlineMs,
      activeExecutions: this.#active.size,
    });
    return this.snapshot();
  }

  async waitForDrain({ deadlineMs = 30_000, pollMs = 10, signal } = {}) {
    if (this.#state === 'accepting') throw shutdownError('DRAIN_NOT_STARTED', 'beginDrain() must be called before waitForDrain()');
    if (!Number.isInteger(deadlineMs) || deadlineMs < 0) throw shutdownError('DEADLINE_INVALID', 'deadlineMs must be a non-negative integer');
    if (!Number.isInteger(pollMs) || pollMs < 0) throw shutdownError('POLL_INTERVAL_INVALID', 'pollMs must be a non-negative integer');
    const deadline = this.clock() + deadlineMs;
    while (this.#active.size > 0) {
      if (signal?.aborted) throw shutdownError('DRAIN_CANCELLED', 'Drain wait was cancelled', true);
      if (this.clock() >= deadline) {
        const remaining = [...this.#active.keys()].sort();
        this.#record('deadline_exceeded', null, { remainingExecutions: remaining });
        throw Object.assign(shutdownError('DRAIN_DEADLINE_EXCEEDED', 'Shutdown drain deadline exceeded', true), { remainingExecutions: remaining });
      }
      await delay(pollMs, signal);
    }
    this.#state = 'stopped';
    this.#record('drained', null, { remainingExecutions: [] });
    return this.snapshot();
  }

  forceStop({ reason = 'forced' } = {}) {
    const remaining = [...this.#active.keys()].sort();
    this.#active.clear();
    this.#state = 'stopped';
    this.#record('forced_stop', null, { reason: sanitizeReason(reason), remainingExecutions: remaining });
    return this.snapshot();
  }

  isAdmitted(executionId) { return this.#active.has(executionId); }
  activeExecutions() { return Object.freeze([...this.#active.keys()].sort()); }
  history() { return Object.freeze(this.#history.map(clone)); }

  snapshot() {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      state: this.#state,
      activeCount: this.#active.size,
      activeExecutions: [...this.#active.keys()].sort(),
      history: this.#history,
    });
  }

  #record(event, executionId, details) {
    this.#history.push(freeze({ schemaVersion: SCHEMA_VERSION, id: this.idFactory('shutdown'), event, executionId, timestamp: this.clock(), ...details }));
    while (this.#history.length > this.historyLimit) this.#history.shift();
  }
}

function delay(ms, signal) {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(shutdownError('DRAIN_CANCELLED', 'Drain wait was cancelled', true)); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
function sanitize(value) { return value && typeof value === 'object' ? structuredClone(value) : {}; }
function sanitizeReason(value) { return typeof value === 'string' && value ? value : 'unspecified'; }
function shutdownError(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function clone(value) { return value == null ? value : structuredClone(value); }

export { SCHEMA_VERSION as RUNTIME_SHUTDOWN_ADMISSION_SCHEMA_VERSION, STATES as RUNTIME_SHUTDOWN_ADMISSION_STATES };