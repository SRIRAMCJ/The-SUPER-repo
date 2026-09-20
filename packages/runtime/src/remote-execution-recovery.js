const SCHEMA_VERSION = '0.1.0';

export const REMOTE_EXECUTION_RECOVERY_SCHEMA_VERSION = SCHEMA_VERSION;

export class RemoteExecutionRecovery {
  #scheduler;
  #transport;
  #maxAttempts;

  constructor({ scheduler, transport, maxAttempts = 2 } = {}) {
    if (!scheduler || typeof scheduler.reassign !== 'function' || typeof scheduler.schedule !== 'function') throw new TypeError('scheduler must expose schedule() and reassign()');
    if (!transport || typeof transport.execute !== 'function') throw new TypeError('transport must expose execute()');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
    this.#scheduler = scheduler;
    this.#transport = transport;
    this.#maxAttempts = maxAttempts;
  }

  async execute({ executionId, capabilityId, input = {}, context = {}, capability, initialSchedule = null } = {}) {
    let schedule = initialSchedule ?? this.#scheduler.schedule({ executionId, capabilityId });
    if (schedule.state !== 'scheduled') return {
      state: 'failed',
      executionId,
      error: {
        code: schedule.code ?? 'REMOTE_SCHEDULING_FAILED',
        message: schedule.code ?? 'remote scheduling failed',
        retryable: schedule.retryable === true,
      },
    };

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const result = await this.#transport.execute(
          { executionId, capability: capability ?? { id: capabilityId }, input },
          {
            ...context,
            workerId: schedule.workerId,
            leaseId: schedule.leaseId,
            fencingToken: schedule.fencingToken,
          },
        );

        if (result.status === 'succeeded' || result.status === 'cancelled' || result.status === 'timed_out') return { ...result, state: 'completed', attempt };
        if (result.error?.retryable !== true || attempt === this.#maxAttempts) return { ...result, state: 'failed', attempt };
      } catch (error) {
        if (error?.retryable !== true || attempt === this.#maxAttempts) return {
          state: 'failed',
          executionId,
          attempt,
          error: {
            code: error?.code ?? 'REMOTE_EXECUTION_FAILED',
            message: error?.message ?? String(error),
            retryable: error?.retryable === true,
          },
        };
      }

      const activeSchedule = this.#scheduler.current?.(executionId);
      schedule = activeSchedule ?? this.#scheduler.reassign({
        executionId,
        capabilityId,
        failedWorkerId: schedule.workerId,
        reason: 'remote execution recovery',
      });
      if (schedule.state !== 'scheduled') return {
        state: 'failed',
        executionId,
        attempt,
        error: {
          code: schedule.code ?? 'REMOTE_REASSIGNMENT_FAILED',
          message: schedule.code ?? 'remote reassignment failed',
          retryable: schedule.retryable === true,
        },
      };
    }

    return {
      state: 'failed',
      executionId,
      error: {
        code: 'REMOTE_RECOVERY_EXHAUSTED',
        message: 'remote recovery attempts exhausted',
        retryable: false,
      },
    };
  }
}
