const SCHEMA_VERSION = '0.2.0';

export const REMOTE_WORKER_HEARTBEAT_SCHEMA_VERSION = SCHEMA_VERSION;

export class RemoteWorkerHeartbeatMonitor {
  #registry;
  #clock;
  #timeoutMs;
  #leaseManager;
  #onExecutionLost;

  constructor({ registry, clock = () => Date.now(), timeoutMs = 30_000, leaseManager = null, onExecutionLost = null } = {}) {
    if (!registry || typeof registry.list !== 'function' || typeof registry.markUnhealthy !== 'function') {
      throw new TypeError('worker registry is required');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    if (leaseManager && (typeof leaseManager.list !== 'function' || typeof leaseManager.fence !== 'function')) {
      throw new TypeError('leaseManager must expose list() and fence()');
    }
    if (onExecutionLost !== null && typeof onExecutionLost !== 'function') throw new TypeError('onExecutionLost must be a function');
    this.#registry = registry;
    this.#clock = clock;
    this.#timeoutMs = timeoutMs;
    this.#leaseManager = leaseManager;
    this.#onExecutionLost = onExecutionLost;
  }

  async sweep() {
    const now = this.#clock();
    const changed = [];
    const lost = [];
    for (const worker of this.#registry.list()) {
      const lastHeartbeat = Date.parse(worker.lastHeartbeatAt);
      if (worker.state === 'healthy' && Number.isFinite(lastHeartbeat) && now - lastHeartbeat > this.#timeoutMs) {
        const result = this.#registry.markUnhealthy(worker.workerId, 'heartbeat timeout');
        changed.push(result.worker);
        if (this.#leaseManager) {
          for (const lease of this.#leaseManager.list()) {
            if (lease.status !== 'active' || lease.workerId !== worker.workerId) continue;
            const fenced = this.#leaseManager.fence(lease.leaseId, 'worker heartbeat timeout', lease.fencingToken);
            if (!fenced.lease) continue;
            const event = Object.freeze({
              executionId: lease.executionId,
              workerId: worker.workerId,
              leaseId: lease.leaseId,
              fencingToken: lease.fencingToken,
              state: 'lost',
            });
            lost.push(event);
            await this.#onExecutionLost?.(event);
          }
        }
      }
    }
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      checkedAt: new Date(now).toISOString(),
      changed: Object.freeze(changed.map((worker) => structuredClone(worker))),
      lost: Object.freeze(lost.map((event) => structuredClone(event))),
    });
  }

  status() {
    const workers = this.#registry.list();
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      total: workers.length,
      healthy: workers.filter((worker) => worker.state === 'healthy').length,
      unhealthy: workers.filter((worker) => worker.state !== 'healthy').length,
    });
  }
}
