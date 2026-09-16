export class ExecutionRecovery {
  constructor({ stateStore, planExecutor } = {}) {
    if (!stateStore) throw new TypeError('ExecutionRecovery requires stateStore');
    if (!planExecutor) throw new TypeError('ExecutionRecovery requires planExecutor');
    this.stateStore = stateStore;
    this.planExecutor = planExecutor;
  }

  async inspect(executionId) {
    return this.stateStore.get(executionId);
  }

  async listRecoverable({ includeRunning = false } = {}) {
    const states = await this.stateStore.list();
    return states.filter((state) => state.status === 'failed' || (includeRunning && state.status === 'running'));
  }

  async resume(plan, executionId, context = {}) {
    return this.planExecutor.resume(plan, executionId, context);
  }

  async recover(plan, executionId, context = {}) {
    return this.planExecutor.resume(plan, executionId, context, { allowRunning: true });
  }
}
