const SCHEMA_VERSION = '0.1.0';

// Local admission gate. A lease is retained until the underlying handler settles.
export class RuntimeShutdownAdmission {
  #state = 'accepting';
  #active = new Map();
  #waiters = new Set();
  #deadlineAt = null;

  state() { return this.#state; }
  activeExecutions() { return Object.freeze([...this.#active.keys()].sort()); }
  snapshot() { return Object.freeze({ schemaVersion: SCHEMA_VERSION, state: this.#state, activeCount: this.#active.size, activeExecutions: this.activeExecutions(), deadlineAt: this.#deadlineAt }); }

  admit(executionId) {
    if (typeof executionId !== 'string' || !executionId.trim()) throw gateError('EXECUTION_ID_INVALID');
    if (this.#state !== 'accepting') throw gateError('ADMISSION_CLOSED');
    if (this.#active.has(executionId)) throw gateError('EXECUTION_ALREADY_ADMITTED');
    const token = crypto.randomUUID();
    this.#active.set(executionId, token);
    return Object.freeze({ executionId, token });
  }

  release(lease) {
    if (!lease || this.#active.get(lease.executionId) !== lease.token) return false;
    this.#active.delete(lease.executionId);
    if (this.#active.size === 0) this.#notify();
    return true;
  }

  beginDrain({ deadlineMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw gateError('DEADLINE_INVALID');
    if (this.#state === 'accepting') {
      this.#deadlineAt = Date.now() + deadlineMs;
      this.#state = 'draining';
      if (this.#active.size === 0) this.#notify();
    }
    return this.snapshot();
  }

  async waitForDrain({ signal } = {}) {
    if (this.#state === 'accepting') throw gateError('DRAIN_NOT_STARTED');
    if (this.#state === 'stopped') {
      if (this.#active.size) throw gateError('ACTIVE_EXECUTIONS_PRESENT');
      return this.snapshot();
    }
    if (this.#active.size === 0) { this.#state = 'stopped'; return this.snapshot(); }
    if (signal?.aborted) throw gateError('DRAIN_CANCELLED');
    const remainingMs = Math.max(0, this.#deadlineAt - Date.now());
    if (!remainingMs) throw deadlineError(this.activeExecutions());
    await new Promise((resolve, reject) => {
      const finish = (error) => { clearTimeout(timer); this.#waiters.delete(onChange); signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(); };
      const onChange = () => { if (this.#active.size === 0) finish(); };
      const onAbort = () => finish(gateError('DRAIN_CANCELLED'));
      const timer = setTimeout(() => finish(deadlineError(this.activeExecutions())), remainingMs);
      this.#waiters.add(onChange);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    this.#state = 'stopped';
    return this.snapshot();
  }

  forceStop() {
    this.#state = 'stopped';
    // Forced stop closes admission; it does not claim to cancel external work.
    return this.snapshot();
  }

  reopen() {
    if (this.#state !== 'stopped') throw gateError('ADMISSION_NOT_STOPPED');
    if (this.#active.size) throw gateError('ACTIVE_EXECUTIONS_PRESENT');
    this.#state = 'accepting';
    this.#deadlineAt = null;
    return this.snapshot();
  }

  #notify() { for (const waiter of [...this.#waiters]) waiter(); }
}

function gateError(code) { return Object.assign(new Error(code), { code }); }
function deadlineError(remainingExecutions) { return Object.assign(gateError('DRAIN_DEADLINE_EXCEEDED'), { remainingExecutions }); }
export { SCHEMA_VERSION as RUNTIME_SHUTDOWN_ADMISSION_SCHEMA_VERSION };
