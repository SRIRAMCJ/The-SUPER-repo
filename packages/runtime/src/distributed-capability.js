const SCHEMA_VERSION = '0.1.0';
const TRUSTED_NODE_STATES = new Set(['active', 'draining']);

export class DistributedCapabilityGate {
  constructor({ clock = () => new Date(), idFactory = defaultId, leaseTtlMs = 30_000, maxRecords = 1_000, events = null, security = null } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) throw new TypeError('leaseTtlMs must be a positive integer');
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be a positive integer');
    if (events && typeof events.emit !== 'function') throw new TypeError('events must expose emit()');
    if (security && typeof security.authorize !== 'function') throw new TypeError('security must expose authorize()');
    this.clock = clock; this.idFactory = idFactory; this.leaseTtlMs = leaseTtlMs; this.maxRecords = maxRecords; this.events = events; this.security = security;
    this.leases = new Map(); this.executions = new Map(); this.nodes = new Map();
  }

  registerNode({ nodeId, state = 'active', capabilities = [] } = {}) {
    validateNodeId(nodeId); if (!TRUSTED_NODE_STATES.has(state)) throw failure('NODE_STATE_INVALID', `Invalid node state: ${state}`);
    if (!Array.isArray(capabilities) || capabilities.some((v) => typeof v !== 'string' || !v)) throw failure('NODE_CAPABILITIES_INVALID', 'capabilities must be non-empty strings');
    const record = freeze({ schemaVersion: SCHEMA_VERSION, nodeId, state, capabilities: [...new Set(capabilities)].sort(), updatedAt: this.clock().toISOString() });
    this.nodes.set(nodeId, record); return clone(record);
  }

  acquireLease({ executionId, nodeId, requestedTtlMs = this.leaseTtlMs } = {}) {
    validateExecutionId(executionId); validateNodeId(nodeId);
    const node = this.nodes.get(nodeId); if (!node || !TRUSTED_NODE_STATES.has(node.state)) throw failure('NODE_NOT_AVAILABLE', `Node is not available: ${nodeId}`);
    const now = this.now(); const current = this.leases.get(executionId);
    if (current && current.expiresAtMs > now && current.nodeId !== nodeId) throw failure('LEASE_HELD', `Execution lease is held by ${current.nodeId}`, true);
    const fencingToken = (current?.fencingToken ?? 0) + 1;
    const ttl = Math.min(Math.max(1, Number(requestedTtlMs) || this.leaseTtlMs), this.leaseTtlMs);
    const lease = freeze({ schemaVersion: SCHEMA_VERSION, executionId, nodeId, fencingToken, acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString() });
    this.leases.set(executionId, lease); this.emit('distributed.lease.acquired', executionId, { nodeId, fencingToken }); return clone(lease);
  }

  renewLease({ executionId, nodeId, fencingToken } = {}) {
    const lease = this.requireLease(executionId, nodeId, fencingToken); const now = this.now();
    if (Date.parse(lease.expiresAt) <= now) throw failure('LEASE_EXPIRED', 'Lease has expired', true);
    const renewed = freeze({ ...lease, expiresAt: new Date(now + this.leaseTtlMs).toISOString() });
    this.leases.set(executionId, renewed); return clone(renewed);
  }

  releaseLease({ executionId, nodeId, fencingToken } = {}) {
    this.requireLease(executionId, nodeId, fencingToken); this.leases.delete(executionId); this.emit('distributed.lease.released', executionId, { nodeId, fencingToken }); return true;
  }

  async execute({ executionId, nodeId, fencingToken, idempotencyKey, capability, input = {}, handler, signal = null, securityContext = null } = {}) {
    validateExecutionId(executionId); validateNodeId(nodeId); if (typeof fencingToken !== 'number' || !Number.isInteger(fencingToken) || fencingToken < 1) throw failure('FENCING_TOKEN_INVALID', 'A valid fencing token is required');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) throw failure('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required');
    if (typeof capability !== 'string' || !capability) throw failure('CAPABILITY_REQUIRED', 'capability is required');
    if (typeof handler !== 'function') throw failure('HANDLER_INVALID', 'handler must be a function');
    const lease = this.requireLease(executionId, nodeId, fencingToken);
    if (Date.parse(lease.expiresAt) <= this.now()) throw failure('LEASE_EXPIRED', 'Lease has expired', true);
    const key = `${nodeId}:${executionId}:${idempotencyKey}`; const existing = this.executions.get(key);
    if (existing) return clone(existing);
    if (signal?.aborted) return this.record(key, terminal(executionId, nodeId, fencingToken, idempotencyKey, 'cancelled', { code: 'EXECUTION_CANCELLED', message: 'Execution cancelled before start', retryable: false }));
    if (this.security) {
      const decision = await this.security.authorize({ nodeId, executionId, capability, context: securityContext });
      if (decision?.allowed === false) return this.record(key, terminal(executionId, nodeId, fencingToken, idempotencyKey, 'failed', { code: 'SECURITY_DENIED', message: decision.reason ?? 'Distributed execution denied', retryable: false }));
    }
    let result;
    try {
      result = await handler({ executionId, nodeId, fencingToken, capability, input: structuredClone(input), signal });
      if (signal?.aborted) return this.record(key, terminal(executionId, nodeId, fencingToken, idempotencyKey, 'cancelled', { code: 'EXECUTION_CANCELLED', message: 'Execution cancelled', retryable: false }, result));
      return this.record(key, terminal(executionId, nodeId, fencingToken, idempotencyKey, 'succeeded', null, result));
    } catch (error) {
      return this.record(key, terminal(executionId, nodeId, fencingToken, idempotencyKey, 'failed', normalizeError(error), undefined));
    }
  }

  validateLease({ executionId, nodeId, fencingToken } = {}) {
    return clone(this.requireLease(executionId, nodeId, fencingToken));
  }

  getExecution({ executionId, nodeId, idempotencyKey } = {}) { return clone(this.executions.get(`${nodeId}:${executionId}:${idempotencyKey}`) ?? null); }
  listNodes() { return Object.freeze([...this.nodes.values()].map(clone)); }
  listExecutions() { return Object.freeze([...this.executions.values()].map(clone)); }

  requireLease(executionId, nodeId, fencingToken) {
    validateExecutionId(executionId); validateNodeId(nodeId);
    const lease = this.leases.get(executionId);
    if (!lease || lease.nodeId !== nodeId) throw failure('LEASE_NOT_HELD', 'Execution is not owned by this node', true);
    if (lease.fencingToken !== fencingToken) throw failure('STALE_FENCING_TOKEN', 'Fencing token is stale', true);
    return lease;
  }

  record(key, record) { this.executions.set(key, freeze(record)); while (this.executions.size > this.maxRecords) this.executions.delete(this.executions.keys().next().value); this.emit(`distributed.execution.${record.status}`, record.executionId, { nodeId: record.nodeId, fencingToken: record.fencingToken, idempotencyKey: record.idempotencyKey }); return clone(this.executions.get(key)); }
  emit(type, executionId, data) { this.events?.emit({ schemaVersion: SCHEMA_VERSION, type, executionId, timestamp: this.clock().toISOString(), data: structuredClone(data) }); }
  now() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date'); return value.getTime(); }
}

function terminal(executionId, nodeId, fencingToken, idempotencyKey, status, error, result) { return { schemaVersion: SCHEMA_VERSION, type: 'distributed-execution', executionId, nodeId, fencingToken, idempotencyKey, status, finishedAt: new Date().toISOString(), ...(result === undefined ? {} : { result: structuredClone(result) }), ...(error ? { error } : {}) }; }
function validateExecutionId(value) { if (typeof value !== 'string' || !value) throw failure('EXECUTION_ID_INVALID', 'executionId is required'); }
function validateNodeId(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw failure('NODE_ID_INVALID', 'nodeId must be a bounded identifier'); }
function failure(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }
function normalizeError(error) { return { code: error?.code ?? 'DISTRIBUTED_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) }; }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function clone(value) { return value === undefined || value === null ? value : structuredClone(value); }
function defaultId(prefix = 'distributed') { return `${prefix}-${Date.now().toString(36)}`; }

export { SCHEMA_VERSION as DISTRIBUTED_CAPABILITY_SCHEMA_VERSION };
