const SCHEMA_VERSION = '0.2.0';

export const REMOTE_WORKER_SCHEDULER_SCHEMA_VERSION = SCHEMA_VERSION;

export class RemoteWorkerScheduler {
  #registry;
  #leases;
  #clock;

  constructor({ registry, leases, clock = () => Date.now() } = {}) {
    if (!registry || typeof registry.resolveCapability !== 'function' || typeof registry.list !== 'function') throw new TypeError('worker registry is required');
    if (!leases || typeof leases.acquire !== 'function' || typeof leases.fence !== 'function' || typeof leases.findByExecution !== 'function') throw new TypeError('lease manager is required');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.#registry = registry;
    this.#leases = leases;
    this.#clock = clock;
  }

  schedule({ executionId, capabilityId, excludeWorkerIds = [] } = {}) {
    return this.#schedule({ executionId, capabilityId, excludeWorkerIds });
  }

  current(executionId) {
    const lease = this.#leases.findByExecution(executionId);
    return lease?.status === 'active'
      ? Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        state: 'scheduled',
        executionId,
        workerId: lease.workerId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      })
      : null;
  }

  reassign({ executionId, capabilityId, failedWorkerId = null, reason = 'remote worker failure' } = {}) {
    const current = this.#leases.findByExecution(executionId);
    if (current?.status === 'active') this.#leases.fence(current.leaseId, reason, current.fencingToken);
    return this.#schedule({
      executionId,
      capabilityId,
      excludeWorkerIds: failedWorkerId ? [failedWorkerId] : (current?.workerId ? [current.workerId] : []),
    });
  }

  #schedule({ executionId, capabilityId, excludeWorkerIds = [] } = {}) {
    if (typeof executionId !== 'string' || !executionId.trim() || typeof capabilityId !== 'string' || !capabilityId.trim()) {
      throw new TypeError('executionId and capabilityId are required');
    }

    const excluded = new Set(excludeWorkerIds);
    let worker = this.#registry.resolveCapability(capabilityId);
    if (worker && excluded.has(worker.workerId)) {
      const candidates = this.#registry.list()
        .filter((candidate) => candidate.state === 'healthy' && candidate.capabilities.includes(capabilityId) && !excluded.has(candidate.workerId))
        .sort((a, b) => a.workerId.localeCompare(b.workerId));
      worker = candidates[0] ?? null;
    }

    if (!worker) return this.#result('unavailable', {
      code: 'NO_CAPABLE_WORKER',
      executionId,
      capabilityId,
      retryable: true,
    });

    const lease = this.#leases.acquire({ executionId, workerId: worker.workerId });
    if (lease.state !== 'acquired') return this.#result('conflict', {
      code: lease.code ?? 'LEASE_CONFLICT',
      executionId,
      workerId: worker.workerId,
      retryable: true,
    });

    return this.#result('scheduled', {
      executionId,
      capabilityId,
      workerId: worker.workerId,
      leaseId: lease.lease.leaseId,
      fencingToken: lease.lease.fencingToken,
      scheduledAt: new Date(this.#clock()).toISOString(),
      attempt: this.#leases.list().filter((entry) => entry.executionId === executionId).length,
    });
  }

  #result(state, data) {
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, state, ...data });
  }
}
