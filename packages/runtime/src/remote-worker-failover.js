import { RemoteRecoveryCoordinator } from './remote-recovery-coordinator.js';

const SCHEMA_VERSION = '0.2.0';
export const REMOTE_WORKER_FAILOVER_SCHEMA_VERSION = SCHEMA_VERSION;

export class RemoteWorkerFailoverController {
  #scheduler;
  #capabilityResolver;
  #recovery;

  constructor({ scheduler, capabilityResolver = null, recoveryCoordinator = null } = {}) {
    if (!scheduler || typeof scheduler.reassign !== 'function') throw new TypeError('scheduler must expose reassign()');
    if (capabilityResolver !== null && typeof capabilityResolver !== 'function') throw new TypeError('capabilityResolver must be a function');
    this.#scheduler = scheduler;
    this.#capabilityResolver = capabilityResolver;
    this.#recovery = recoveryCoordinator ?? new RemoteRecoveryCoordinator();
    if (!this.#recovery || typeof this.#recovery.run !== 'function') throw new TypeError('recoveryCoordinator must expose run()');
  }

  async handleExecutionLost({ executionId, workerId, capabilityId = null } = {}) {
    if (typeof executionId !== 'string' || !executionId.trim()) throw new TypeError('executionId is required');
    return this.#recovery.run(executionId, async () => {
      const resolvedCapability = capabilityId ?? await this.#capabilityResolver?.(executionId);
      if (!resolvedCapability) return Object.freeze({ schemaVersion: SCHEMA_VERSION, state: 'blocked', executionId, code: 'CAPABILITY_REQUIRED' });

      const schedule = this.#scheduler.current?.(executionId);
      if (schedule && schedule.workerId !== workerId) return Object.freeze({
        schemaVersion: SCHEMA_VERSION, state: 'already_reassigned', executionId,
        workerId: schedule.workerId, leaseId: schedule.leaseId, fencingToken: schedule.fencingToken,
      });

      const result = this.#scheduler.reassign({
        executionId, capabilityId: resolvedCapability, failedWorkerId: workerId, reason: 'heartbeat failure',
      });

      return Object.freeze({
        schemaVersion: SCHEMA_VERSION, state: result.state, executionId,
        workerId: result.workerId ?? null, leaseId: result.leaseId ?? null,
        fencingToken: result.fencingToken ?? null, code: result.code ?? null,
        retryable: result.retryable ?? false,
      });
    });
  }
}
