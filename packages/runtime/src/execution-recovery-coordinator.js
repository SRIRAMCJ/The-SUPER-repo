const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['idle', 'recovering', 'succeeded', 'failed', 'blocked']);

export class ExecutionRecoveryCoordinator {
  #attempts = new Map();
  #history = [];

  constructor({ durableState, transaction, supervisor = null, clock = () => new Date(), idFactory = defaultId, maxAttempts = 3, maxHistory = 256, staleAfterMs = 300_000 } = {}) {
    if (!durableState || typeof durableState.load !== 'function') throw new TypeError('durableState must expose load()');
    if (!transaction || typeof transaction.recover !== 'function') throw new TypeError('transaction must expose recover()');
    if (supervisor && typeof supervisor.health !== 'function') throw new TypeError('supervisor must expose health()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    if (!Number.isInteger(staleAfterMs) || staleAfterMs < 0) throw new TypeError('staleAfterMs must be a non-negative integer');
    this.durableState = durableState; this.transaction = transaction; this.supervisor = supervisor;
    this.clock = clock; this.idFactory = idFactory; this.maxAttempts = maxAttempts; this.maxHistory = maxHistory; this.staleAfterMs = staleAfterMs;
  }

  async recover({ signal, force = false, reason = 'process_restart' } = {}) {
    if (signal?.aborted) return this.#result('blocked', null, 'RECOVERY_CANCELLED', 'Recovery cancelled before scan');
    if (this.supervisor) {
      const health = await this.supervisor.health({ correlationId: this.idFactory('recovery-health'), signal });
      if (health.state === 'failed' || health.state === 'unavailable') return this.#result('blocked', null, 'SUPERVISOR_UNHEALTHY', 'Runtime supervisor is not safe for recovery');
    }
    const states = await this.durableState.load();
    const candidates = states.filter(state => state.status === 'active' && this.#isStale(state));
    const results = [];
    for (const state of candidates) {
      if (signal?.aborted) break;
      const attempt = (this.#attempts.get(state.transactionId) ?? 0) + 1;
      this.#attempts.set(state.transactionId, attempt);
      if (attempt > this.maxAttempts && !force) {
        results.push({ transactionId: state.transactionId, status: 'blocked', reason: 'recovery_attempt_limit' });
        this.#record({ event: 'recovery_blocked', transactionId: state.transactionId, attempt, reason: 'recovery_attempt_limit' });
        continue;
      }
      try {
        const recovered = await this.transaction.recover(state.transactionId, { signal });
        results.push({ transactionId: state.transactionId, status: recovered.status, attempt, recovered });
        this.#record({ event: 'recovery_completed', transactionId: state.transactionId, attempt, status: recovered.status });
      } catch (error) {
        const normalized = normalizeError(error, 'RECOVERY_FAILED');
        results.push({ transactionId: state.transactionId, status: 'failed', attempt, error: normalized });
        this.#record({ event: 'recovery_failed', transactionId: state.transactionId, attempt, error: normalized });
      }
    }
    const status = signal?.aborted ? 'blocked' : results.some(item => item.status === 'failed' || item.status === 'rollback_failed') ? 'failed' : 'succeeded';
    return this.#result(status, results, null, null, reason);
  }

  async scan() {
    const states = await this.durableState.load();
    return freeze(states.filter(state => state.status === 'active' && this.#isStale(state)).map(clone));
  }

  attempts(transactionId) { return this.#attempts.get(transactionId) ?? 0; }
  history() { return deepFreeze(this.#history.map(clone)); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, type: 'execution-recovery-coordinator', generatedAt: this.nowIso(), state: this.#history.at(-1)?.status ?? 'idle', attempts: Object.fromEntries(this.#attempts), history: this.#history }); }

  #isStale(state) {
    const timestamp = Date.parse(state.updatedAt ?? state.timestamp ?? '');
    return Number.isFinite(timestamp) && this.clock().getTime() - timestamp >= this.staleAfterMs;
  }

  #result(status, results, code = null, message = null, reason = 'recovery') {
    const result = freeze({ schemaVersion: SCHEMA_VERSION, type: 'execution-recovery-result', recoveryId: this.idFactory('recovery'), status, reason, results: results ?? [], error: code ? { code, message, retryable: true } : null, completedAt: this.nowIso() });
    this.#record({ event: 'recovery_run', recoveryId: result.recoveryId, status, result: result.results });
    return result;
  }

  #record(value) {
    this.#history.push(freeze({ schemaVersion: SCHEMA_VERSION, id: this.idFactory('recovery-event'), timestamp: this.nowIso(), ...value }));
    while (this.#history.length > this.maxHistory) this.#history.shift();
  }

  nowIso() {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date');
    return value.toISOString();
  }
}

function normalizeError(error, fallbackCode) { return { code: error?.code ?? fallbackCode, message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function defaultId(prefix) { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as EXECUTION_RECOVERY_COORDINATOR_SCHEMA_VERSION, STATES as EXECUTION_RECOVERY_COORDINATOR_STATES };
