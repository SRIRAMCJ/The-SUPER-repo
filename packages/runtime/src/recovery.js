export class ExecutionRecovery {
  constructor({ stateStore, planExecutor, taskGraphExecutor = null } = {}) {
    if (!stateStore) throw new TypeError('ExecutionRecovery requires stateStore');
    if (!planExecutor) throw new TypeError('ExecutionRecovery requires planExecutor');
    if (taskGraphExecutor && typeof taskGraphExecutor.resume !== 'function') throw new TypeError('ExecutionRecovery taskGraphExecutor must expose resume');
    this.stateStore = stateStore;
    this.planExecutor = planExecutor;
    this.taskGraphExecutor = taskGraphExecutor;
  }

  async inspect(executionId) { return this.stateStore.get(executionId); }

  async listRecoverable({ includeRunning = false } = {}) {
    const states = await this.stateStore.list();
    return states.filter((state) => state.status === 'failed' || (includeRunning && state.status === 'running'));
  }

  async resume(plan, executionId, context = {}, options = {}) {
    const state = await this.stateStore.get(executionId);
    if (state?.kind === 'task-graph') {
      if (!this.taskGraphExecutor) return failure(executionId, 'TASK_GRAPH_RECOVERY_UNAVAILABLE', 'Task graph recovery is not configured');
      return this.taskGraphExecutor.resume(plan, executionId, context, options);
    }
    return this.planExecutor.resume(plan, executionId, context, options);
  }

  async recover(plan, executionId, context = {}) {
    return this.resume(plan, executionId, context, { allowRunning: true });
  }
}

function failure(executionId, code, message) {
  return { executionId, status: 'failed', error: { code, message, retryable: false } };
}
