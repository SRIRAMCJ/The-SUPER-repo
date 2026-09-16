import { createExecutionId } from './events.js';
import { ExecutionStateStore, isTerminalExecutionStatus } from './state.js';

export class ExecutionPlanExecutor {
  constructor({ executionEngine, events = null, clock = () => new Date(), stateStore = null } = {}) {
    if (!executionEngine) throw new TypeError('ExecutionPlanExecutor requires executionEngine');
    this.executionEngine = executionEngine;
    this.events = events;
    this.clock = clock;
    this.stateStore = stateStore;
  }

  async execute(plan, input = {}, context = {}) {
    validatePlan(plan);
    const executionId = createExecutionId();
    const startedAt = this.clock().toISOString();
    return this.#run(plan, executionId, startedAt, 1, input, [], context, 1, false);
  }

  async resume(plan, executionId, context = {}) {
    validatePlan(plan);
    if (!this.stateStore) throw Object.assign(new Error('Execution state store is required for resume'), { code: 'EXECUTION_STATE_UNAVAILABLE', retryable: false });
    const state = await this.stateStore.get(executionId);
    if (!state) return { executionId, root: plan.root, status: 'failed', error: { code: 'EXECUTION_STATE_NOT_FOUND', message: `Execution state not found: ${executionId}`, retryable: false } };
    if (state.type !== 'plan') return { executionId, root: plan.root, status: 'failed', error: { code: 'EXECUTION_STATE_TYPE_INVALID', message: `Execution state is not a plan: ${executionId}`, retryable: false } };
    if (state.root !== plan.root) return { executionId, root: plan.root, status: 'failed', error: { code: 'EXECUTION_STATE_PLAN_MISMATCH', message: `Execution state root does not match plan: ${executionId}`, retryable: false } };
    if (state.status === 'succeeded') return { executionId, root: plan.root, status: 'succeeded', output: state.output, verification: state.verification ?? null, results: state.results ?? [], resumed: false };
    if (isTerminalExecutionStatus(state.status) && state.status !== 'failed') return { executionId, root: plan.root, status: 'failed', error: { code: 'EXECUTION_NOT_RESUMABLE', message: `Execution is not resumable: ${state.status}`, retryable: false } };
    if (!Number.isInteger(state.nextStep) || state.nextStep < 1 || state.nextStep > plan.steps.length) return { executionId, root: plan.root, status: 'failed', error: { code: 'EXECUTION_STATE_CURSOR_INVALID', message: `Invalid resume cursor for ${executionId}`, retryable: false } };

    const claimed = await this.stateStore.update(executionId, { status: 'running', attempt: (state.attempt ?? 1) + 1, error: null }, state.version);
    return this.#run(plan, executionId, claimed.startedAt ?? this.clock().toISOString(), state.nextStep, state.currentInput, state.results ?? [], context, claimed.attempt, true);
  }

  async #run(plan, executionId, startedAt, startStep, input, priorResults, context, attempt, resumed) {
    let current = input;
    const results = [...priorResults];
    if (this.stateStore && !resumed) {
      await this.stateStore.create({ schemaVersion: '0.1.0', type: 'execution-state', executionId, kind: 'plan', root: plan.root, status: 'running', nextStep: startStep, currentInput: current, results: [], attempt, startedAt, plan });
    }

    this.events?.emit({ type: resumed ? 'plan.resumed' : 'plan.started', executionId, planType: plan.type, root: plan.root, status: 'started', data: { stepCount: plan.steps.length, startStep, attempt } });

    try {
      for (let index = startStep - 1; index < plan.steps.length; index += 1) {
        const step = plan.steps[index];
        if (this.stateStore) await this.stateStore.update(executionId, { status: 'running', nextStep: step.step, currentInput: current, attempt }, undefined);
        const result = await this.executionEngine.execute(step.capabilityId, current, { ...context, planExecutionId: executionId, planStep: step.step });
        const entry = { step: step.step, capabilityId: step.capabilityId, attempt, result };
        results.push(entry);

        if (result.status !== 'succeeded') {
          const failed = { executionId, root: plan.root, status: 'failed', startedAt, finishedAt: this.clock().toISOString(), results, error: result.error, resumed };
          if (this.stateStore) await this.stateStore.update(executionId, { status: 'failed', nextStep: step.step, currentInput: current, results, error: result.error, finishedAt: failed.finishedAt, attempt });
          this.events?.emit({ type: 'plan.failed', executionId, root: plan.root, status: 'failed', error: result.error, data: { step: step.step, attempt } });
          return failed;
        }

        current = result.output;
        if (this.stateStore) await this.stateStore.update(executionId, { status: 'running', nextStep: step.step + 1, currentInput: current, results, error: null, attempt }, undefined);
      }

      const completed = { executionId, root: plan.root, status: 'succeeded', startedAt, finishedAt: this.clock().toISOString(), output: current, verification: results.at(-1)?.result?.verification ?? null, results, resumed };
      if (this.stateStore) await this.stateStore.update(executionId, { status: 'succeeded', nextStep: plan.steps.length + 1, currentInput: current, output: current, verification: completed.verification, results, error: null, finishedAt: completed.finishedAt, attempt }, undefined);
      this.events?.emit({ type: 'plan.completed', executionId, root: plan.root, status: 'completed', data: { steps: results.length, attempt } });
      return completed;
    } catch (error) {
      const normalized = normalizePlanError(error);
      if (this.stateStore) await this.stateStore.update(executionId, { status: 'failed', nextStep: Math.min(startStep, plan.steps.length), currentInput: current, results, error: normalized, finishedAt: this.clock().toISOString(), attempt }, undefined);
      this.events?.emit({ type: 'plan.failed', executionId, root: plan.root, status: 'failed', error: normalized });
      return { executionId, root: plan.root, status: 'failed', startedAt, finishedAt: this.clock().toISOString(), results, error: normalized, resumed };
    }
  }
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new TypeError('Execution plan is required');
  if (plan.type !== 'execution-plan' || plan.schemaVersion !== '0.1.0') throw new TypeError('Unsupported execution plan schema');
  if (!Array.isArray(plan.steps) || !plan.steps.length) throw new TypeError('Execution plan must contain at least one step');
  let expectedStep = 1;
  for (const step of plan.steps) {
    if (!Number.isInteger(step?.step) || step.step !== expectedStep) throw new TypeError('Execution plan steps must be sequentially numbered');
    if (typeof step.capabilityId !== 'string' || !step.capabilityId) throw new TypeError(`Execution plan step ${expectedStep} requires capabilityId`);
    expectedStep += 1;
  }
  if (plan.steps.at(-1).capabilityId !== plan.root) throw new TypeError('Execution plan root must be the final step');
}

function normalizePlanError(error) {
  return {
    code: error?.code ?? 'PLAN_EXECUTION_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: Boolean(error?.retryable)
  };
}
