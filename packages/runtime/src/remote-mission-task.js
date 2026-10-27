import { createHash } from 'node:crypto';

const RETRYABLE = new Set(['REMOTE_IN_PROGRESS', 'REMOTE_RECOVERY_REQUIRED', 'REMOTE_CONNECTION_CLOSED',
  'REMOTE_TIMEOUT', 'FAILOVER_LEASE_HELD', 'FAILOVER_FENCE_REJECTED', 'FAILOVER_LOCK_TIMEOUT']);

// Supply this callback to TaskGraphExecutor.executeTask. A mission task maps to
// exactly one registered worker capability; policy and audit live on the worker.
export function createRemoteMissionTaskHandler({ coordinator } = {}) {
  if (typeof coordinator?.execute !== 'function') throw new TypeError('Remote mission tasks require a coordinator');
  return async (task, input, context) => {
    if (!Array.isArray(task?.capabilities) || task.capabilities.length !== 1 ||
        typeof context?.executionId !== 'string' || !context.executionId ||
        typeof task.id !== 'string' || !task.id ||
        !input || typeof input !== 'object' || Array.isArray(input)) throw fault('REMOTE_TASK_INVALID');
    const digest = createHash('sha256').update(JSON.stringify([context.executionId, task.id])).digest('hex');
    try {
      const output = await coordinator.execute({ executionId: `task-${digest}`, requestId: `request-${digest}`,
        capabilityId: task.capabilities[0], input });
      return { status: 'succeeded', output };
    } catch (error) {
      if (RETRYABLE.has(error?.code)) error.retryable = true;
      throw error;
    }
  };
}

function fault(code) { return Object.assign(new Error(code), { code, retryable: false }); }
