const SCHEMA_VERSION = '0.2.0';
const TRUSTED_NODE_STATES = new Set(['active', 'draining']);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

export class DistributedCapabilityGate {
  #inflight = new Map();

  constructor({ clock = () => new Date(), idFactory = defaultId, leaseTtlMs = 30_000, maxRecords = 1_000, events = null, security = null } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) throw new TypeError('leaseTtlMs must be a positive integer');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    if (events && typeof events.emit !== 'function') throw new TypeError('events must expose emit()');
    if (security && typeof security.authorize !== 'function') throw new TypeError('security must expose authorize()');
    this.clock = clock;
    this.idFactory = idFactory;
    this.leaseTtlMs = leaseTtlMs;
    this.maxRecords = maxRecords;
    this.events = events;
    this.security = security;
    this.leases = new Map();
    this.executions = new Map();
    this.nodes = new Map();
  }

  registerNode({ nodeId, state = 'active', capabilities = [] } = {}) {
    validateNodeId(nodeId);
    if (!TRUSTED_NODE_STATES.has(state)) throw failure('NODE_STATE_INVALID', `Invalid node state: ${state}`);
    if (!Array.isArray(capabilities) || capabilities.some((v) => typeof v !== 'string' || !v.trim())) throw failure('NODE_CAPABILITIES_INVALID', 'capabilities must be non-empty strings');
    const record = freeze({ schemaVersion: SCHEMA_VERSION, nodeId, state, capabilities: [...new Set(capabilities.map((v) => v.trim()))].sort(), updatedAt: this.nowIso() });
    this.nodes.set(nodeId, record);
    return clone(record);
  }

  updateNode({ nodeId, state, capabilities } = {}) {
    const current = this.nodes.get(nodeId);
    if (!current) throw failure('NODE_NOT_FOUND', `Node is not registered: ${nodeId}`);
    return this.registerNode({ nodeId, state: state ?? current.state, capabilities: capabilities ?? current.capabilities });
  }

  acquireLease({ executionId, nodeId, requestedTtlMs = this.leaseTtlMs } = {}) {
    validateExecutionId(executionId);
    validateNodeId(nodeId);
    const node = this.nodes.get(nodeId);
    if (!node || node.state !== 'active') throw failure('NODE_NOT_AVAILABLE', `Node is not accepting new execution: ${nodeId}`);
    const now = this.nowMs();
    const current = this.leases.get(executionId);
    if (current && Date.parse(current.expiresAt) > now && current.nodeId !== nodeId) throw failure('LEASE_HELD', `Execution lease is held by ${current.nodeId}`, true);
    const fencingToken = (current?.fencingToken ?? 0) + 1;
    const ttl = Math.min(Math.max(1, Number(requestedTtlMs) || this.leaseTtlMs), this.leaseTtlMs);
    const lease = freeze({ schemaVersion: SCHEMA_VERSION, executionId, nodeId, fencingToken, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString() });
    this.leases.set(executionId, lease);
    this.emit('distributed.lease.acquired', executionId, { nodeId, fencingToken });
    return clone(lease);
  }

  renewLease({ executionId, nodeId, fencingToken } = {}) {
    const lease = this.requireLease(executionId, nodeId, fencingToken);
    const now = this.nowMs();
    if (Date.parse(lease.expiresAt) <= now) throw failure('LEASE_EXPIRED', 'Lease has expired', true);
    const renewed = freeze({ ...lease, expiresAt: new Date(now + this.leaseTtlMs).toISOString() });
    this.leases.set(executionId, renewed);
    this.emit('distributed.lease.renewed', executionId, { nodeId, fencingToken });
    return clone(renewed);
  }

  releaseLease({ executionId, nodeId, fencingToken } = {}) {
    this.requireLease(executionId, nodeId, fencingToken);
    this.leases.delete(executionId);
    this.emit('distributed.lease.released', executionId, { nodeId, fencingToken });
    return true;
  }

  async execute({ executionId, nodeId, fencingToken, idempotencyKey, capability, input = {}, handler, signal = null, securityContext = null } = {}) {
    validateExecutionId(executionId);
    validateNodeId(nodeId);
    if (!Number.isInteger(fencingToken) || fencingToken < 1) throw failure('FENCING_TOKEN_INVALID', 'A valid fencing token is required');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) throw failure('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required');
    const capabilityRequest = normalizeCapability(capability);
    if (typeof handler !== 'function') throw failure('HANDLER_INVALID', 'handler must be a function');
    const lease = this.requireLease(executionId, nodeId, fencingToken);
    if (Date.parse(lease.expiresAt) <= this.nowMs()) throw failure('LEASE_EXPIRED', 'Lease has expired', true);
    const node = this.nodes.get(nodeId);
    if (!node.capabilities.includes('*') && !node.capabilities.includes(capabilityRequest.id)) throw failure('CAPABILITY_NOT_ASSIGNED', `Node cannot execute capability: ${capabilityRequest.id}`);

    const key = `${nodeId}:${executionId}:${idempotencyKey}`;
    const existing = this.executions.get(key);
    if (existing) return clone(existing);
    if (this.#inflight.has(key)) return clone(await this.#inflight.get(key));

    const run = this.#executeOnce({ key, executionId, nodeId, fencingToken, idempotencyKey, capabilityRequest, input, handler, signal, securityContext });
    this.#inflight.set(key, run);
    try {
      return clone(await run);
    } finally {
      this.#inflight.delete(key);
    }
  }

  async #executeOnce({ key, executionId, nodeId, fencingToken, idempotencyKey, capabilityRequest, input, handler, signal, securityContext }) {
    if (signal?.aborted) return this.record(key, terminal(this.nowIso(), executionId, nodeId, fencingToken, idempotencyKey, 'cancelled', { code: 'EXECUTION_CANCELLED', message: 'Execution cancelled before start', retryable: false }));
    if (this.security) {
      try {
        const decision = await this.security.authorize(capabilityRequest, securityContext ?? {});
        if (decision?.allowed !== true) return this.record(key, terminal(this.nowIso(), executionId, nodeId, fencingToken, idempotencyKey, 'failed', { code: 'SECURITY_DENIED', message: decision?.reason ?? 'Distributed execution denied', retryable: false }));
      } catch (error) {
        return this.record(key, terminal(this.nowIso(), executionId, nodeId, fencingToken, idempotencyKey, 'failed', { code: 'SECURITY_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }));
      }
    }

    try {
      const result = await handler({ executionId, nodeId, fencingToken, capability: capabilityRequest.id, input: structuredClone(input), signal });
      if (signal?.aborted) return this.record(key, terminal(this.nowIso(), executionId, nodeId, fencingToken, idempotencyKey, 'cancelled', { code: 'EXECUTION_CANCELLED', message: 'Execution cancelled', retryable: false }, result));
      this.requireLease(executionId, nodeId, fencingToken);
      if (Date.parse(this.leases.get(executionId).expiresAt) <= this.nowMs()) throw failure('LEASE_EXPIRED', 'Lease expired before execution commit', true);
      return this.record(key, terminal(this.nowIso(), executionId, nodeId, fencingToken, idempotencyKey, 'succeeded', null, result));
    } catch (error) {
      return this.record(key, terminal(this.nowIso(), executionId, nodeId, fencingToken, idempotencyKey, 'failed', normalizeError(error)));
    }
  }

  validateLease({ executionId, nodeId, fencingToken } = {}) { return clone(this.requireLease(executionId, nodeId, fencingToken)); }
  getExecution({ executionId, nodeId, idempotencyKey } = {}) { return clone(this.executions.get(`${nodeId}:${executionId}:${idempotencyKey}`) ?? null); }
  listNodes() { return Object.freeze([...this.nodes.values()].map(clone)); }
  listExecutions() { return Object.freeze([...this.executions.values()].map(clone)); }

  requireLease(executionId, nodeId, fencingToken) {
    validateExecutionId(executionId);
    validateNodeId(nodeId);
    const lease = this.leases.get(executionId);
    if (!lease || lease.nodeId !== nodeId) throw failure('LEASE_NOT_HELD', 'Execution is not owned by this node', true);
    if (lease.fencingToken !== fencingToken) throw failure('STALE_FENCING_TOKEN', 'Fencing token is stale', true);
    return lease;
  }

  record(key, record) {
    if (!TERMINAL_STATES.has(record.status)) throw failure('TERMINAL_STATE_INVALID', `Invalid distributed terminal state: ${record.status}`);
    const existing = this.executions.get(key);
    if (existing) return clone(existing);
    this.executions.set(key, freeze(record));
    while (this.executions.size > this.maxRecords) this.executions.delete(this.executions.keys().next().value);
    this.emit(`distributed.execution.${record.status}`, record.executionId, { nodeId: record.nodeId, fencingToken: record.fencingToken, idempotencyKey: record.idempotencyKey });
    return clone(this.executions.get(key));
  }

  emit(type, executionId, data) { this.events?.emit({ schemaVersion: SCHEMA_VERSION, type, executionId, timestamp: this.nowIso(), data: structuredClone(data) }); }
  nowMs() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date'); return value.getTime(); }
  nowIso() { return new Date(this.nowMs()).toISOString(); }
}

function terminal(finishedAt, executionId, nodeId, fencingToken, idempotencyKey, status, error = null, result) { return { schemaVersion: SCHEMA_VERSION, type: 'distributed-execution', executionId, nodeId, fencingToken, idempotencyKey, status, finishedAt, ...(result === undefined ? {} : { result: structuredClone(result) }), ...(error ? { error } : {}) }; }
function normalizeCapability(value) { if (typeof value === 'string' && value) return { id: value }; if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id) throw failure('CAPABILITY_REQUIRED', 'capability must be a non-empty id or capability object'); return structuredClone(value); }
function validateExecutionId(value) { if (typeof value !== 'string' || !value) throw failure('EXECUTION_ID_INVALID', 'executionId is required'); }
function validateNodeId(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw failure('NODE_ID_INVALID', 'nodeId must be a bounded identifier'); }
function failure(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function normalizeError(error) { return { code: error?.code ?? 'DISTRIBUTED_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function clone(value) { return value === undefined || value === null ? value : structuredClone(value); }
function defaultId(prefix = 'distributed') { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as DISTRIBUTED_CAPABILITY_SCHEMA_VERSION, TRUSTED_NODE_STATES as DISTRIBUTED_NODE_STATES, TERMINAL_STATES as DISTRIBUTED_TERMINAL_STATES };
