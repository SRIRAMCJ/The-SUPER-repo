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

  async listRecoverable() {
    const states = await this.stateStore.list();
    return states.filter((state) => state.status === 'running' || state.status === 'failed');
  }

  async resume(plan, executionId, context = {}) {
    return this.planExecutor.resume(plan, executionId, context);
  }
}
