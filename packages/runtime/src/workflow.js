export class WorkflowEngine {
  constructor({ executionEngine, registry, policy = null, events = null }) {
    if (!executionEngine || !registry) throw new TypeError('WorkflowEngine requires executionEngine and registry');
    this.executionEngine = executionEngine;
    this.registry = registry;
    this.policy = policy;
    this.events = events;
  }

  async execute(workflow, input = {}, context = {}) {
    if (!workflow || workflow.kind !== 'workflow') throw new TypeError('A workflow capability manifest is required');
    const results = [];
    let current = input;

    for (const step of workflow.steps ?? []) {
      const entry = this.registry.require(step.capability);
      const decision = this.policy?.authorize(entry.manifest, context) ?? { allowed: true };
      if (!decision.allowed) throw Object.assign(new Error(decision.reason), { code: 'POLICY_DENIED' });

      const result = await this.executionEngine.execute(step.capability, current, context);
      results.push({ step: step.id ?? step.capability, result });
      if (result.status !== 'succeeded') return { status: 'failed', results, error: result.error };
      current = result.output;
    }

    this.events?.emit({ type: 'workflow.completed', workflowId: workflow.id, status: 'completed', data: { steps: results.length } });
    return { status: 'succeeded', output: current, results };
  }
}
