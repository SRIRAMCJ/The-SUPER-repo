import { CapabilityPlanner } from './planner.js';

export class AgentRuntime {
  constructor({ registry, planner = null, missionEngine, events = null, clock = () => new Date() } = {}) {
    if (!registry || !missionEngine) throw new TypeError('AgentRuntime requires registry and missionEngine');
    this.registry = registry;
    this.planner = planner ?? new CapabilityPlanner({ registry, clock });
    this.missionEngine = missionEngine;
    this.events = events;
    this.clock = clock;
  }

  async execute(agent, input = {}, context = {}) {
    if (!agent || agent.kind !== 'agent') throw new TypeError('An agent capability manifest is required');
    const startedAt = this.clock().toISOString();
    const executionId = crypto.randomUUID();
    this.events?.emit({ type: 'agent.started', executionId, agentId: agent.id, status: 'started', data: { input } });

    try {
      const missionId = agent.execution?.mission;
      if (!missionId) throw Object.assign(new Error(`Agent has no execution mission: ${agent.id}`), { code: 'AGENT_MISSION_MISSING' });
      const mission = this.registry.require(missionId).manifest;
      const result = await this.missionEngine.execute(mission, input, context);
      const agentResult = { executionId, agentId: agent.id, startedAt, finishedAt: this.clock().toISOString(), ...result };
      this.events?.emit({
        type: result.status === 'succeeded' ? 'agent.completed' : 'agent.failed',
        executionId,
        agentId: agent.id,
        status: result.status,
        data: agentResult,
        error: result.error
      });
      return agentResult;
    } catch (error) {
      const normalized = normalizeAgentError(error);
      const result = { executionId, agentId: agent.id, startedAt, finishedAt: this.clock().toISOString(), status: 'failed', error: normalized };
      this.events?.emit({ type: 'agent.failed', executionId, agentId: agent.id, status: 'failed', error: normalized, data: result });
      return result;
    }
  }

  plan(request, options = {}) {
    return this.planner.plan(request, options);
  }

  async executeRequest(request, input = {}, context = {}, options = {}) {
    const plan = this.plan(request, { kind: 'agent', ...options });
    if (!plan.selection) {
      return { status: 'failed', error: { code: 'NO_AGENT_MATCH', message: 'No registered agent matched the request', retryable: false }, plan };
    }
    const agent = this.registry.require(plan.selection.capabilityId).manifest;
    const result = await this.execute(agent, input, context);
    return { ...result, plan };
  }
}

function normalizeAgentError(error) {
  return { code: error?.code ?? 'AGENT_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) };
}
