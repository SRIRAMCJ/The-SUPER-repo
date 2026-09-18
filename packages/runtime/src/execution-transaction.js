const SCHEMA_VERSION = '0.1.0';
const STATES = Object.freeze(['active', 'committed', 'rolled_back', 'rollback_failed', 'abandoned']);

export class RuntimeExecutionTransactionKernel {
  #transactions = new Map();
  #idempotency = new Map();
  #history = [];

  constructor({ admission, durableState = null, clock = () => new Date(), idFactory = defaultId, maxHistory = 256 } = {}) {
    if (!admission || typeof admission.admit !== 'function' || typeof admission.release !== 'function') {
      throw new TypeError('admission must expose admit() and release()');
    }
    if (durableState && (typeof durableState.record !== 'function' || typeof durableState.load !== 'function')) throw new TypeError('durableState must expose record() and load()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.admission = admission;
    this.durableState = durableState;
    this.clock = clock;
    this.idFactory = idFactory;
    this.maxHistory = maxHistory;
  }

  async begin({ executionId, idempotencyKey = null, operation = 'runtime.execute', resources = {}, metadata = {}, context = {}, signal } = {}) {
    validateId(executionId, 'executionId');
    validateOptionalId(idempotencyKey, 'idempotencyKey');
    if (signal?.aborted) throw transactionError('TRANSACTION_CANCELLED', 'Transaction was cancelled before admission', true);

    const existing = this.#findExisting(executionId, idempotencyKey);
    if (existing) return this.#replay(existing);

    const transactionId = this.idFactory('transaction');
    const correlationId = context.correlationId ?? metadata.correlationId ?? this.idFactory('correlation');
    const admission = await this.admission.admit({
      executionId,
      resources,
      metadata: { ...sanitize(metadata), operationId: operation },
      context: { ...sanitize(context), operationId: operation, correlationId },
      signal
    });

    const transaction = {
      schemaVersion: SCHEMA_VERSION,
      type: 'execution-transaction',
      transactionId,
      executionId,
      idempotencyKey: idempotencyKey ?? null,
      operation,
      correlationId,
      status: 'active',
      startedAt: this.nowIso(),
      admission: clone(admission),
      resources: sanitize(resources),
      metadata: sanitize(metadata),
      compensations: []
    };
    this.#transactions.set(transactionId, transaction);
    if (idempotencyKey) this.#idempotency.set(idempotencyKey, transactionId);
    this.#record({ event: 'began', transactionId, executionId, correlationId, status: 'active' });
    await this.#persist(transaction);
    return this.#public(transaction);
  }

  registerCompensation(transactionId, handler, { id = this.idFactory('compensation'), metadata = {} } = {}) {
    const transaction = this.#active(transactionId);
    validateId(id, 'compensation id');
    if (typeof handler !== 'function') throw new TypeError('compensation handler must be a function');
    if (transaction.compensations.some(item => item.id === id)) throw transactionError('COMPENSATION_DUPLICATE', `Compensation already exists: ${id}`);
    transaction.compensations.push({ id, handler, metadata: sanitize(metadata), registeredAt: this.nowIso(), status: 'pending' });
    this.#record({ event: 'compensation_registered', transactionId, compensationId: id, correlationId: transaction.correlationId });
    return freeze({ transactionId, compensationId: id, status: 'pending', metadata: sanitize(metadata) });
  }

  async commit(transactionId, result = undefined) {
    const transaction = this.#active(transactionId);
    transaction.status = 'committed';
    transaction.result = clone(result);
    transaction.completedAt = this.nowIso();
    try {
      const release = this.admission.release(transaction.executionId, { resources: transaction.resources, reason: 'transaction_committed' });
      transaction.release = clone(release);
    } catch (error) {
      transaction.status = 'rollback_failed';
      transaction.error = normalizeError(error, 'TRANSACTION_RELEASE_FAILED');
      transaction.completedAt = this.nowIso();
      this.#record({ event: 'commit_release_failed', transactionId, correlationId: transaction.correlationId, status: transaction.status, error: transaction.error });
      throw Object.assign(new Error(transaction.error.message), transaction.error);
    }
    this.#record({ event: 'committed', transactionId, executionId: transaction.executionId, correlationId: transaction.correlationId, status: transaction.status });
    await this.#persist(transaction);
    return this.#public(transaction);
  }

  async rollback(transactionId, reason = 'transaction_failed', { signal } = {}) {
    const transaction = this.#active(transactionId);
    transaction.status = 'rolled_back';
    transaction.rollbackReason = sanitizeReason(reason);
    const compensationResults = [];
    let failed = false;

    for (let index = transaction.compensations.length - 1; index >= 0; index -= 1) {
      const compensation = transaction.compensations[index];
      if (compensation.status !== 'pending') continue;
      if (signal?.aborted) {
        compensation.status = 'cancelled';
        failed = true;
        compensationResults.push({ id: compensation.id, status: 'cancelled', error: { code: 'TRANSACTION_CANCELLED', message: 'Compensation cancelled', retryable: true } });
        continue;
      }
      compensation.status = 'running';
      try {
        const value = await compensation.handler({
          transactionId,
          executionId: transaction.executionId,
          correlationId: transaction.correlationId,
          signal,
          metadata: clone(compensation.metadata)
        });
        compensation.status = 'succeeded';
        compensation.result = clone(value);
        compensationResults.push({ id: compensation.id, status: 'succeeded', result: clone(value) });
      } catch (error) {
        compensation.status = 'failed';
        compensation.error = normalizeError(error, 'COMPENSATION_FAILED');
        failed = true;
        compensationResults.push({ id: compensation.id, status: 'failed', error: clone(compensation.error) });
      }
    }

    try {
      transaction.release = clone(this.admission.release(transaction.executionId, { resources: transaction.resources, reason: failed ? 'transaction_rollback_failed' : 'transaction_rolled_back' }));
    } catch (error) {
      failed = true;
      transaction.releaseError = normalizeError(error, 'TRANSACTION_RELEASE_FAILED');
    }
    transaction.status = failed ? 'rollback_failed' : 'rolled_back';
    transaction.compensationResults = compensationResults;
    transaction.completedAt = this.nowIso();
    transaction.error = failed ? { code: signal?.aborted ? 'TRANSACTION_CANCELLED' : 'ROLLBACK_FAILED', message: signal?.aborted ? 'Rollback was cancelled or incomplete' : 'One or more rollback steps failed', retryable: true } : undefined;
    this.#record({ event: failed ? 'rollback_failed' : 'rolled_back', transactionId, executionId: transaction.executionId, correlationId: transaction.correlationId, status: transaction.status, compensationResults: clone(compensationResults) });
    await this.#persist(transaction);
    return this.#public(transaction);
  }

  async execute({ executionId, idempotencyKey = null, operation = 'runtime.execute', resources = {}, metadata = {}, context = {}, signal, handler, compensations = [] } = {}) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    validateId(executionId, 'executionId');
    const existing = this.#findExisting(executionId, idempotencyKey);
    if (existing && existing.status !== 'active') return this.#replay(existing);

    const transaction = await this.begin({ executionId, idempotencyKey, operation, resources, metadata, context, signal });
    if (transaction.replayed) return transaction;
    const registered = [];
    try {
      for (const item of compensations) {
        if (typeof item === 'function') registered.push(this.registerCompensation(transaction.transactionId, item));
        else registered.push(this.registerCompensation(transaction.transactionId, item.handler, item));
      }
      if (signal?.aborted) throw transactionError('TRANSACTION_CANCELLED', 'Transaction was cancelled before execution', true);
      const value = await handler({ transactionId: transaction.transactionId, executionId, correlationId: transaction.correlationId, signal, admission: clone(transaction.admission), registerCompensation: (fn, options) => this.registerCompensation(transaction.transactionId, fn, options) });
      return this.commit(transaction.transactionId, value);
    } catch (error) {
      const cancelled = signal?.aborted || error?.name === 'AbortError' || error?.code === 'TRANSACTION_CANCELLED';
      return this.rollback(transaction.transactionId, cancelled ? 'cancelled' : 'execution_failed', { signal });
    }
  }

  async recover(transactionId, { signal } = {}) {
    const transaction = this.#active(transactionId);
    return this.rollback(transactionId, 'recovery_abandoned_transaction', { signal });
  }

  async recoverDurable() {
    if (!this.durableState) throw transactionError('DURABLE_STATE_UNAVAILABLE', 'No durable state store configured');
    const states = await this.durableState.load();
    for (const state of states) {
      if (this.#transactions.has(state.transactionId)) continue;
      this.#transactions.set(state.transactionId, { ...state, compensations: [], admission: null, resources: {}, metadata: {} });
      if (state.idempotencyKey) this.#idempotency.set(state.idempotencyKey, state.transactionId);
    }
    return freeze(states.map(clone));
  }

  get(transactionId) {
    const transaction = this.#transactions.get(transactionId);
    return transaction ? this.#public(transaction) : null;
  }

  history() { return Object.freeze(this.#history.map(clone)); }

  snapshot() {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      type: 'execution-transaction-kernel',
      generatedAt: this.nowIso(),
      transactions: [...this.#transactions.values()].map(item => this.#public(item)),
      history: this.#history
    });
  }

  #active(transactionId) {
    validateId(transactionId, 'transactionId');
    const transaction = this.#transactions.get(transactionId);
    if (!transaction) throw transactionError('TRANSACTION_NOT_FOUND', `Unknown transaction: ${transactionId}`);
    if (transaction.status !== 'active') throw transactionError('TRANSACTION_TERMINAL', `Transaction is already ${transaction.status}`);
    return transaction;
  }

  #findExisting(executionId, idempotencyKey) {
    if (idempotencyKey) {
      const id = this.#idempotency.get(idempotencyKey);
      if (id) return this.#transactions.get(id);
    }
    for (const transaction of this.#transactions.values()) if (transaction.executionId === executionId && transaction.status === 'active') return transaction;
    return null;
  }

  #replay(transaction) {
    return freeze({ ...this.#public(transaction), replayed: true });
  }

  #public(transaction) {
    const value = { ...transaction, compensations: transaction.compensations.map(({ handler, ...item }) => item) };
    return freeze(value);
  }

  async #persist(transaction) {
    if (!this.durableState) return;
    await this.durableState.record({ executionId: transaction.executionId, transactionId: transaction.transactionId, status: transaction.status, operation: transaction.operation, correlationId: transaction.correlationId, idempotencyKey: transaction.idempotencyKey, result: transaction.result, error: transaction.error });
  }

  #record(value) {
    this.#history.push(freeze({ schemaVersion: SCHEMA_VERSION, id: this.idFactory('transaction-event'), timestamp: this.nowIso(), ...value }));
    while (this.#history.length > this.maxHistory) this.#history.shift();
  }

  nowIso() {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date');
    return value.toISOString();
  }
}

function validateId(value, name) { if (typeof value !== 'string' || !value.trim()) throw transactionError('ID_INVALID', `${name} must be a non-empty string`); }
function validateOptionalId(value, name) { if (value !== null && value !== undefined) validateId(value, name); }
function sanitize(value) { return value && typeof value === 'object' ? redact(structuredClone(value)) : {}; }
function redact(value) { if (Array.isArray(value)) return value.map(redact); if (!value || typeof value !== 'object') return value; const out = {}; for (const [key, child] of Object.entries(value)) out[key] = /pass(word)?|secret|token|api[_-]?key|private[_-]?key/i.test(key) ? '[REDACTED]' : redact(child); return out; }
function sanitizeReason(value) { return typeof value === 'string' && value.trim() ? value.trim() : 'unspecified'; }
function normalizeError(error, fallbackCode) { return { code: error?.code ?? fallbackCode, message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function transactionError(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function defaultId(prefix) { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as RUNTIME_EXECUTION_TRANSACTION_SCHEMA_VERSION, STATES as RUNTIME_EXECUTION_TRANSACTION_STATES };
