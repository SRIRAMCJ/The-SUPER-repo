const SCHEMA_VERSION = '0.1.0';
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export class RemoteExecutionTransport {
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
    const existing = this.requests.get(requestId);
    if (existing) return clone(existing);
    const controller = new AbortController();
    const detach = linkAbort(signal, controller);
    const timeout = Number(timeoutMs);
    if (!Number.isInteger(timeout) || timeout <= 0) throw failure('TIMEOUT_INVALID', 'timeoutMs must be a positive integer');
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const result = await this.distributed.execute({ executionId, nodeId, fencingToken, idempotencyKey, capability, input, handler, signal: controller.signal, securityContext });
      const state = normalizeResult(requestId, result, controller.signal.aborted && result?.status === 'succeeded' ? 'timed_out' : result?.status);
      return this.record(requestId, state);
    } catch (error) {
      const status = controller.signal.aborted ? 'timed_out' : 'failed';
      return this.record(requestId, { schemaVersion: SCHEMA_VERSION, type: 'remote-execution', requestId, executionId, nodeId, status, finishedAt: this.nowIso(), error: normalizeError(error) });
    } finally {
      clearTimeout(timer);
      detach();
    }
  }

  get(requestId) { return clone(this.requests.get(requestId) ?? null); }
  list() { return Object.freeze([...this.requests.values()].map(clone)); }
  clear(requestId) { return this.requests.delete(requestId); }

  record(requestId, record) {
    if (!TERMINAL_STATES.has(record.status)) throw failure('REMOTE_STATE_INVALID', `Invalid remote terminal state: ${record.status}`);
    const existing = this.requests.get(requestId);
    if (existing) return clone(existing);
    this.requests.set(requestId, deepFreeze(structuredClone(record)));
    while (this.requests.size > this.maxRecords) this.requests.delete(this.requests.keys().next().value);
    return clone(this.requests.get(requestId));
  }

  nowIso() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date'); return value.toISOString(); }
}

function normalizeResult(requestId, result, status) {
  const safeStatus = TERMINAL_STATES.has(status) ? status : 'failed';
  return { schemaVersion: SCHEMA_VERSION, type: 'remote-execution', requestId, executionId: result?.executionId, nodeId: result?.nodeId, fencingToken: result?.fencingToken, idempotencyKey: result?.idempotencyKey, status: safeStatus, finishedAt: result?.finishedAt ?? new Date().toISOString(), ...(result?.result === undefined ? {} : { result: structuredClone(result.result) }), ...(result?.error ? { error: structuredClone(result.error) } : {}) };
}
function linkAbort(parent, controller) { if (!parent) return () => {}; if (parent.aborted) controller.abort(); const onAbort = () => controller.abort(); parent.addEventListener('abort', onAbort, { once: true }); return () => parent.removeEventListener('abort', onAbort); }
function validateString(value, code, name) { if (typeof value !== 'string' || !value) throw failure(code, `${name} is required`); }
function failure(code, message) { return Object.assign(new Error(message), { code, retryable: false }); }
function normalizeError(error) { return { code: error?.code ?? 'REMOTE_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function clone(value) { return value === undefined || value === null ? value : structuredClone(value); }
function defaultId(prefix = 'remote') { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as REMOTE_EXECUTION_TRANSPORT_SCHEMA_VERSION, TERMINAL_STATES as REMOTE_EXECUTION_TERMINAL_STATES };
