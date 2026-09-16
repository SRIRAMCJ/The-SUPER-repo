import { createExecutionId } from './events.js';

export class WorkflowEngine {
  constructor({ executionEngine, registry, policy = null, events = null, clock = () => new Date(), planBuilder = null, planExecutor = null }) {
    if (!executionEngine || !registry) throw new TypeError('WorkflowEngine requires executionEngine and registry');
    if (Boolean(planBuilder) !== Boolean(planExecutor)) throw new TypeError('WorkflowEngine planBuilder and planExecutor must be provided together');
    this.executionEngine = executionEngine;
    this.registry = registry;
    this.policy = policy;
    this.events = events;
    this.clock = clock;
    this.planBuilder = planBuilder;
    this.planExecutor = planExecutor;
  }

  async execute(workflow, input = {}, context = {}) {
    if (!workflow || workflow.kind !== 'workflow') throw new TypeError('A workflow capability manifest is required');
    const workflowExecutionId = createExecutionId();
    const startedAt = this.clock().toISOString();
    const results = [];
    let current = input;
    this.events?.emit({ type: 'workflow.started', executionId: workflowExecutionId, workflowId: workflow.id, status: 'started', data: { input } });

    try {
      for (const step of workflow.steps ?? []) {
        const entry = this.registry.require(step.capability);
        const decision = this.policy?.authorize(entry.manifest, context) ?? { allowed: true };
        if (!decision.allowed) {
          const error = { code: 'POLICY_DENIED', message: decision.reason, retryable: false };
          const failed = { workflowExecutionId, workflowId: workflow.id, status: 'failed', startedAt, finishedAt: this.clock().toISOString(), results, error };
          this.events?.emit({ type: 'workflow.failed', executionId: workflowExecutionId, workflowId: workflow.id, status: 'failed', error });
          return failed;
        }

        const result = this.planBuilder
          ? await this.executePlannedStep(step, entry, current, context)
          : await this.executionEngine.execute(step.capability, current, context);
        results.push({ step: step.id ?? step.capability, result });
        if (result.status !== 'succeeded') {
          const failed = { workflowExecutionId, workflowId: workflow.id, status: 'failed', startedAt, finishedAt: this.clock().toISOString(), results, error: result.error };
          this.events?.emit({ type: 'workflow.failed', executionId: workflowExecutionId, workflowId: workflow.id, status: 'failed', error: result.error });
          return failed;
        }
        current = result.output;
      }

      const last = results.at(-1)?.result;
      const completed = { workflowExecutionId, workflowId: workflow.id, status: 'succeeded', startedAt, finishedAt: this.clock().toISOString(), output: current, verification: last?.verification ?? null, executionId: last?.executionId ?? null, results };
      this.events?.emit({ type: 'workflow.completed', executionId: workflowExecutionId, workflowId: workflow.id, status: 'completed', data: { steps: results.length } });
      return completed;
    } catch (error) {
      const normalized = normalizeWorkflowError(error);
      this.events?.emit({ type: 'workflow.failed', executionId: workflowExecutionId, workflowId: workflow.id, status: 'failed', error: normalized });
      return { workflowExecutionId, workflowId: workflow.id, status: 'failed', startedAt, finishedAt: this.clock().toISOString(), results, error: normalized };
    }
  }

  async executePlannedStep(step, entry, input, context) {
    const plan = this.planBuilder.build({
      capabilityId: step.capability,
      domain: context.domain ?? entry.manifest.domain ?? undefined
    });
    if (!plan.ok) return { status: 'failed', error: plan.error, plan };
    const result = await this.planExecutor.execute(plan, input, {
      ...context,
      workflowStep: step.id ?? step.capability
    });
    return { ...result, plan };
  }
}

function normalizeWorkflowError(error) {
  return { code: error?.code ?? 'WORKFLOW_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) };
}
