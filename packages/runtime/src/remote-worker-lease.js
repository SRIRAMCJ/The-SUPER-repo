const SCHEMA_VERSION = '0.2.0';
export const REMOTE_WORKER_LEASE_SCHEMA_VERSION = SCHEMA_VERSION;
const TERMINAL = new Set(['released', 'expired', 'cancelled', 'fenced']);

export class RemoteWorkerLeaseManager {
  #leases = new Map();
  #clock;
  #ttlMs;
  #sequence = 0;
  #fenceSequence = 0;

  constructor({ clock = () => Date.now(), ttlMs = 30_000 } = {}) {
    if (typeof clock !== 'function' || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('valid clock and positive ttlMs are required');
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  acquire({ executionId, workerId } = {}) {
    if (typeof executionId !== 'string' || !executionId.trim() || typeof workerId !== 'string' || !workerId.trim()) {
      throw new TypeError('executionId and workerId are required');
    }
    const now = this.#clock();
    const existing = this.#findExecution(executionId);
    if (existing && !TERMINAL.has(existing.status)) return this.#result('conflict', { code: 'LEASE_ALREADY_HELD', lease: existing });
    const lease = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      leaseId: `lease-${++this.#sequence}`,
      executionId,
      workerId,
      status: 'active',
      fencingToken: `fence-${++this.#fenceSequence}`,
      acquiredAt: now,
      expiresAt: now + this.#ttlMs,
    });
    this.#leases.set(lease.leaseId, lease);
    return this.#result('acquired', { lease });
  }

  renew(leaseId, expectedFencingToken = null) {
    const lease = this.#leases.get(leaseId);
    if (!lease) return this.#result('not_found', { code: 'LEASE_NOT_FOUND', leaseId });
    if (expectedFencingToken && lease.fencingToken !== expectedFencingToken) return this.#result('fenced', { code: 'STALE_FENCING_TOKEN', lease });
    if (lease.status !== 'active') return this.#result('expired', { code: 'LEASE_NOT_ACTIVE', lease });
    const now = this.#clock();
    if (now >= lease.expiresAt) {
      const expired = Object.freeze({ ...lease, status: 'expired', expiredAt: now });
      this.#leases.set(leaseId, expired);
      return this.#result('expired', { code: 'LEASE_EXPIRED', lease: expired });
    }
    const next = Object.freeze({ ...lease, expiresAt: now + this.#ttlMs, lastRenewedAt: now });
    this.#leases.set(leaseId, next);
    return this.#result('renewed', { lease: next });
  }

  validate(leaseId, fencingToken, workerId = null) {
    const lease = this.#leases.get(leaseId);
    if (!lease) return this.#result('invalid', { code: 'LEASE_NOT_FOUND', leaseId });
    if (lease.fencingToken !== fencingToken) return this.#result('invalid', { code: 'STALE_FENCING_TOKEN', lease });
    if (lease.status !== 'active') return this.#result('invalid', { code: 'LEASE_NOT_ACTIVE', lease });
    if (this.#clock() >= lease.expiresAt) return this.#result('invalid', { code: 'LEASE_EXPIRED', lease });
    if (workerId !== null && lease.workerId !== workerId) return this.#result('invalid', { code: 'LEASE_WORKER_MISMATCH', lease });
    return this.#result('valid', { lease });
  }

  fence(leaseId, reason = 'worker lost', expectedFencingToken = null) {
    const lease = this.#leases.get(leaseId);
    if (!lease) return this.#result('not_found', { code: 'LEASE_NOT_FOUND', leaseId });
    if (expectedFencingToken && lease.fencingToken !== expectedFencingToken) return this.#result('fenced', { code: 'STALE_FENCING_TOKEN', lease });
    if (lease.status !== 'active') return this.#result('already_terminal', { lease });
    const next = Object.freeze({ ...lease, status: 'fenced', fencedAt: this.#clock(), fenceReason: String(reason) });
    this.#leases.set(leaseId, next);
    return this.#result('fenced', { lease: next });
  }

  release(leaseId, status = 'released') {
    const lease = this.#leases.get(leaseId);
    if (!lease) return this.#result('not_found', { code: 'LEASE_NOT_FOUND', leaseId });
    if (lease.status !== 'active') return this.#result('already_terminal', { lease });
    if (!TERMINAL.has(status)) throw new TypeError('release status must be terminal');
    const next = Object.freeze({ ...lease, status, releasedAt: this.#clock() });
    this.#leases.set(leaseId, next);
    return this.#result(status, { lease: next });
  }

  expire() {
    const now = this.#clock();
    let count = 0;
    for (const [id, lease] of this.#leases) {
      if (lease.status === 'active' && now >= lease.expiresAt) {
        this.#leases.set(id, Object.freeze({ ...lease, status: 'expired', expiredAt: now }));
        count += 1;
      }
    }
    return Object.freeze({ expired: count, leases: this.list() });
  }

  get(leaseId) {
    const lease = this.#leases.get(leaseId);
    return lease ? structuredClone(lease) : null;
  }

  findByExecution(executionId) {
    const lease = this.#findExecution(executionId);
    return lease ? structuredClone(lease) : null;
  }

  list() {
    return Object.freeze([...this.#leases.values()].map((lease) => structuredClone(lease)));
  }

  #findExecution(executionId) {
    return [...this.#leases.values()].reverse().find((lease) => lease.executionId === executionId) ?? null;
  }

  #result(state, data) {
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, state, ...data });
  }
}
