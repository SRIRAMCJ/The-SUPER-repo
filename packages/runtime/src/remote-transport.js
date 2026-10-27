const SCHEMA_VERSION = '0.1.0';
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export class RemoteExecutionTransport {
  #inflight = new Map();
  #requestSignatures = new Map();
  constructor({ distributed, clock = () => new Date(), idFactory = defaultId, maxRecords = 1_000, requestTimeoutMs = 30_000 } = {}) {
    if (!distributed || typeof distributed.execute !== 'function') throw new TypeError('distributed must expose execute()');
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw new TypeError('requestTimeoutMs must be a positive integer');
    this.distributed = distributed;
    this.clock = clock;
    this.idFactory = idFactory;
    this.maxRecords = maxRecords;
    this.requestTimeoutMs = requestTimeoutMs;
    this.requests = new Map();
  }

  async dispatch({ requestId = this.idFactory('remote'), executionId, nodeId, fencingToken, idempotencyKey, capability, input = {}, handler, signal = null, securityContext = null, timeoutMs = this.requestTimeoutMs } = {}) {
    validateString(requestId, 'REQUEST_ID_INVALID', 'requestId');
    validateString(executionId, 'EXECUTION_ID_INVALID', 'executionId');
    validateString(nodeId, 'NODE_ID_INVALID', 'nodeId');
    validateString(idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey');
    if (typeof handler !== 'function') throw failure('HANDLER_INVALID', 'handler must be a function');
    const signature = JSON.stringify([executionId, nodeId, fencingToken, idempotencyKey, capability, input, securityContext]);
    if (this.#requestSignatures.has(requestId) && this.#requestSignatures.get(requestId) !== signature) throw failure('REQUEST_CONFLICT', 'Request ID was used with different execution parameters');
    const existing = this.requests.get(requestId);
    if (existing) return clone(existing);
    if (this.#inflight.has(requestId)) return clone(await this.#inflight.get(requestId));
    this.#requestSignatures.set(requestId, signature);
    const task = this.#dispatchOnce({ requestId, executionId, nodeId, fencingToken, idempotencyKey, capability, input, handler, signal, securityContext, timeoutMs });
    this.#inflight.set(requestId, task);
    try { return clone(await task); }
    finally { this.#inflight.delete(requestId); if (!this.requests.has(requestId)) this.#requestSignatures.delete(requestId); }
  }

  async #dispatchOnce({ requestId, executionId, nodeId, fencingToken, idempotencyKey, capability, input, handler, signal, securityContext, timeoutMs }) {
    const timeout = Number(timeoutMs);
    if (!Number.isInteger(timeout) || timeout <= 0) throw failure('TIMEOUT_INVALID', 'timeoutMs must be a positive integer');
    const controller = new AbortController();
    const detach = linkAbort(signal, controller);
    const timer = setTimeout(() => controller.abort(failure('REMOTE_TIMEOUT', 'Remote request timed out')), timeout);
    let removeAbort = () => {};
    const aborted = new Promise((_, reject) => {
      const onAbort = () => reject(controller.signal.reason ?? failure('REMOTE_CANCELLED', 'Remote request cancelled'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', onAbort);
      if (controller.signal.aborted) onAbort();
    });
    try {
      const operation = Promise.resolve().then(() => this.distributed.execute({ executionId, nodeId, fencingToken, idempotencyKey, capability, input, handler, signal: controller.signal, securityContext }));
      const result = await Promise.race([operation, aborted]);
      const state = normalizeResult(requestId, result, result?.status);
      return this.record(requestId, state);
    } catch (error) {
      const status = controller.signal.aborted ? (controller.signal.reason?.code === 'REMOTE_TIMEOUT' ? 'timed_out' : 'cancelled') : 'failed';
      return this.record(requestId, { schemaVersion: SCHEMA_VERSION, type: 'remote-execution', requestId, executionId, nodeId, status, finishedAt: this.nowIso(), error: normalizeError(error) });
    } finally {
      clearTimeout(timer);
      detach();
      removeAbort();
    }
  }

  get(requestId) { return clone(this.requests.get(requestId) ?? null); }
  list() { return Object.freeze([...this.requests.values()].map(clone)); }
  clear(requestId) { this.#requestSignatures.delete(requestId); return this.requests.delete(requestId); }

  record(requestId, record) {
    if (!TERMINAL_STATES.has(record.status)) throw failure('REMOTE_STATE_INVALID', `Invalid remote terminal state: ${record.status}`);
    const existing = this.requests.get(requestId);
    if (existing) return clone(existing);
    this.requests.set(requestId, deepFreeze(structuredClone(record)));
    while (this.requests.size > this.maxRecords) {
      const oldest = this.requests.keys().next().value;
      this.requests.delete(oldest);
      this.#requestSignatures.delete(oldest);
    }
    return clone(this.requests.get(requestId));
  }

  nowIso() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date'); return value.toISOString(); }
}

function normalizeResult(requestId, result, status) {
  const safeStatus = TERMINAL_STATES.has(status) ? status : 'failed';
  return { schemaVersion: SCHEMA_VERSION, type: 'remote-execution', requestId, executionId: result?.executionId, nodeId: result?.nodeId, fencingToken: result?.fencingToken, idempotencyKey: result?.idempotencyKey, status: safeStatus, finishedAt: result?.finishedAt ?? new Date().toISOString(), ...(result?.result === undefined ? {} : { result: structuredClone(result.result) }), ...(result?.error ? { error: structuredClone(result.error) } : {}) };
}
function linkAbort(parent, controller) { if (!parent) return () => {}; const reason = () => parent.reason ?? failure('REMOTE_CANCELLED', 'Remote request cancelled'); if (parent.aborted) controller.abort(reason()); const onAbort = () => controller.abort(reason()); parent.addEventListener('abort', onAbort, { once: true }); return () => parent.removeEventListener('abort', onAbort); }
function validateString(value, code, name) { if (typeof value !== 'string' || !value) throw failure(code, `${name} is required`); }
function failure(code, message) { return Object.assign(new Error(message), { code, retryable: false }); }
function normalizeError(error) { return { code: error?.code ?? 'REMOTE_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function clone(value) { return value === undefined || value === null ? value : structuredClone(value); }
function defaultId(prefix = 'remote') { return `${prefix}-${randomUUID()}`; }

export { SCHEMA_VERSION as REMOTE_EXECUTION_TRANSPORT_SCHEMA_VERSION, TERMINAL_STATES as REMOTE_EXECUTION_TERMINAL_STATES };
import { randomUUID } from 'node:crypto';

