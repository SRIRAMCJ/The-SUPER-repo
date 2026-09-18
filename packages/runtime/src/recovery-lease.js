const SCHEMA_VERSION = '0.1.0';

export const RECOVERY_LEASE_STATES = Object.freeze({ HELD: 'held', EXPIRED: 'expired', RELEASED: 'released' });
export const RECOVERY_LEASE_DENIALS = Object.freeze({
  HELD: 'RECOVERY_LEASE_HELD',
  EXPIRED: 'RECOVERY_LEASE_EXPIRED',
  FENCING: 'RECOVERY_LEASE_STALE_FENCING_TOKEN',
  OWNER: 'RECOVERY_LEASE_NOT_OWNER',
  NODE: 'RECOVERY_LEASE_NODE_INVALID',
  EXECUTION: 'RECOVERY_LEASE_EXECUTION_INVALID',
  TTL: 'RECOVERY_LEASE_TTL_INVALID'
});

export class RecoveryLeaseKernel {
  #leases = new Map();
  #history = [];

  constructor({ clock = () => new Date(), idFactory = defaultId, leaseTtlMs = 30_000, maxHistory = 1_000 } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('clock and idFactory must be functions');
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) throw new TypeError('leaseTtlMs must be a positive integer');
    if (!Number.isInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer');
    this.clock = clock; this.idFactory = idFactory; this.leaseTtlMs = leaseTtlMs; this.maxHistory = maxHistory;
  }

  acquire({ executionId, ownerId, nodeId, requestedTtlMs = this.leaseTtlMs, signal = null, reason = 'recovery' } = {}) {
    this.validateInputs(executionId, ownerId, nodeId, requestedTtlMs);
    if (signal?.aborted) throw denial('RECOVERY_LEASE_CANCELLED', 'Recovery lease acquisition cancelled', true);
    const now = this.nowMs();
    const current = this.#leases.get(executionId);
    if (current && current.state === 'held' && current.expiresAtMs > now) {
      if (current.ownerId === ownerId && current.nodeId === nodeId) return clone(current);
      throw denial(RECOVERY_LEASE_DENIALS.HELD, 'Recovery lease is held by another owner', true, { ownerId: current.ownerId, nodeId: current.nodeId, fencingToken: current.fencingToken });
    }
    const fencingToken = (current?.fencingToken ?? 0) + 1;
    const ttlMs = Math.min(requestedTtlMs, this.leaseTtlMs);
    const lease = freeze({
      schemaVersion: SCHEMA_VERSION, leaseId: this.idFactory('recovery-lease'), executionId, ownerId, nodeId,
      fencingToken, state: 'held', reason, acquiredAt: this.nowIso(),
      expiresAt: new Date(now + ttlMs).toISOString(), expiresAtMs: now + ttlMs
    });
    this.#leases.set(executionId, lease); this.audit('acquired', lease); return clone(lease);
  }

  renew({ executionId, ownerId, nodeId, fencingToken, signal = null } = {}) {
    if (signal?.aborted) throw denial('RECOVERY_LEASE_CANCELLED', 'Recovery lease renewal cancelled', true);
    const lease = this.requireHeld(executionId, ownerId, nodeId, fencingToken);
    const now = this.nowMs();
    if (lease.expiresAtMs <= now) { this.expire(lease, now); throw denial(RECOVERY_LEASE_EXPIRED, 'Recovery lease has expired', true, { fencingToken }); }
    const renewed = freeze({ ...lease, expiresAt: new Date(now + this.leaseTtlMs).toISOString(), expiresAtMs: now + this.leaseTtlMs });
    this.#leases.set(executionId, renewed); this.audit('renewed', renewed); return clone(renewed);
  }

  release({ executionId, ownerId, nodeId, fencingToken, signal = null } = {}) {
    if (signal?.aborted) throw denial('RECOVERY_LEASE_CANCELLED', 'Recovery lease release cancelled', true);
    const lease = this.requireHeld(executionId, ownerId, nodeId, fencingToken);
    const released = freeze({ ...lease, state: 'released', releasedAt: this.nowIso() });
    this.#leases.set(executionId, released); this.audit('released', released); return clone(released);
  }

  validate({ executionId, ownerId, nodeId, fencingToken } = {}) { return clone(this.requireHeld(executionId, ownerId, nodeId, fencingToken)); }

  get(executionId) {
    const lease = this.#leases.get(executionId);
    if (!lease) return null;
    if (lease.state === 'held' && lease.expiresAtMs <= this.nowMs()) this.expire(lease, this.nowMs());
    return clone(this.#leases.get(executionId));
  }

  history() { return Object.freeze(this.#history.map(clone)); }
  snapshot() { return freeze({ schemaVersion: SCHEMA_VERSION, active: [...this.#leases.values()].filter(x => x.state === 'held').map(clone), history: this.history() }); }

  requireHeld(executionId, ownerId, nodeId, fencingToken) {
    validateId(executionId, RECOVERY_LEASE_DENIALS.EXECUTION, 'executionId');
    validateId(ownerId, 'RECOVERY_LEASE_OWNER_INVALID', 'ownerId'); validateNode(nodeId);
    if (!Number.isInteger(fencingToken) || fencingToken < 1) throw denial(RECOVERY_LEASE_DENIALS.FENCING, 'A positive fencing token is required');
    const lease = this.#leases.get(executionId);
    if (!lease) throw denial(RECOVERY_LEASE_DENIALS.OWNER, 'No recovery lease exists for execution', true);
    if (lease.state !== 'held') throw denial(RECOVERY_LEASE_DENIALS.EXPIRED, 'Recovery lease is not held', true);
    if (lease.ownerId !== ownerId || lease.nodeId !== nodeId) throw denial(RECOVERY_LEASE_DENIALS.OWNER, 'Recovery lease owner does not match', true, { fencingToken: lease.fencingToken });
    if (lease.fencingToken !== fencingToken) throw denial(RECOVERY_LEASE_DENIALS.FENCING, 'Recovery lease fencing token is stale', true, { currentFencingToken: lease.fencingToken });
    if (lease.expiresAtMs <= this.nowMs()) { this.expire(lease, this.nowMs()); throw denial(RECOVERY_LEASE_DENIALS.EXPIRED, 'Recovery lease has expired', true); }
    return lease;
  }

  expire(lease, now = this.nowMs()) {
    if (lease.state !== 'held') return;
    const expired = freeze({ ...lease, state: 'expired', expiredAt: new Date(now).toISOString() });
    this.#leases.set(lease.executionId, expired); this.audit('expired', expired);
  }

  validateInputs(executionId, ownerId, nodeId, ttl) {
    validateId(executionId, RECOVERY_LEASE_DENIALS.EXECUTION, 'executionId'); validateId(ownerId, 'RECOVERY_LEASE_OWNER_INVALID', 'ownerId'); validateNode(nodeId);
    if (!Number.isInteger(ttl) || ttl <= 0) throw denial(RECOVERY_LEASE_DENIALS.TTL, 'requestedTtlMs must be a positive integer');
  }

  audit(action, lease) {
    this.#history.push(freeze({ schemaVersion: SCHEMA_VERSION, eventId: this.idFactory('recovery-event'), action, timestamp: this.nowIso(),
      executionId: lease.executionId, leaseId: lease.leaseId, ownerId: lease.ownerId, nodeId: lease.nodeId, fencingToken: lease.fencingToken, state: lease.state }));
    while (this.#history.length > this.maxHistory) this.#history.shift();
  }

  nowMs() { const value = this.clock(); if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a valid Date'); return value.getTime(); }
  nowIso() { return new Date(this.nowMs()).toISOString(); }
}

function validateId(value, code, name) { if (typeof value !== 'string' || !value || value.length > 128) throw denial(code, name + ' must be a non-empty bounded identifier'); }
function validateNode(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw denial(RECOVERY_LEASE_DENIALS.NODE, 'nodeId must be a bounded identifier'); }
function denial(code, message, retryable = false, details = {}) { return Object.assign(new Error(message), { code, retryable, details: structuredClone(details) }); }
function freeze(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function clone(value) { return value === undefined || value === null ? value : structuredClone(value); }
function defaultId(prefix) { return prefix + '-' + Date.now().toString(36); }

export { SCHEMA_VERSION as RECOVERY_LEASE_SCHEMA_VERSION };
