import { createExecutionId } from './events.js';

export class ExecutionPlanExecutor {
  constructor({ executionEngine, events = null, clock = () => new Date() } = {}) {
    if (!executionEngine) throw new TypeError('ExecutionPlanExecutor requires executionEngine');
    this.executionEngine = executionEngine;
    this.events = events;
    this.clock = clock;
  }

  async execute(plan, input = {}, context = {}) {
    validatePlan(plan);
    const executionId = createExecutionId();
    const startedAt = this.clock().toISOString();
    const results = [];
    let current = input;

    this.events?.emit({
      type: 'plan.started',
      executionId,
      planType: plan.type,
      root: plan.root,
      status: 'started',
      data: { stepCount: plan.steps.length }
    });

    try {
      for (const step of plan.steps) {
        const result = await this.executionEngine.execute(step.capabilityId, current, {
          ...context,
          planExecutionId: executionId,
          planStep: step.step
        });
        results.push({ step: step.step, capabilityId: step.capabilityId, result });

        if (result.status !== 'succeeded') {
          const failed = {
            executionId,
            root: plan.root,
            status: 'failed',
            startedAt,
            finishedAt: this.clock().toISOString(),
            results,
            error: result.error
          };
          this.events?.emit({ type: 'plan.failed', executionId, root: plan.root, status: 'failed', error: result.error });
          return failed;
        }

        current = result.output;
      }

      const completed = {
        executionId,
        root: plan.root,
        status: 'succeeded',
        startedAt,
        finishedAt: this.clock().toISOString(),
        output: current,
        verification: results.at(-1)?.result?.verification ?? null,
        results
      };
      this.events?.emit({ type: 'plan.completed', executionId, root: plan.root, status: 'completed', data: { steps: results.length } });
      return completed;
    } catch (error) {
      const normalized = normalizePlanError(error);
      this.events?.emit({ type: 'plan.failed', executionId, root: plan.root, status: 'failed', error: normalized });
      return { executionId, root: plan.root, status: 'failed', startedAt, finishedAt: this.clock().toISOString(), results, error: normalized };
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
