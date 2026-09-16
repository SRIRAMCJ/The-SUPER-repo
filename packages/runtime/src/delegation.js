import { createExecutionId } from './events.js';

export class DelegationEngine {
  constructor({ agentRuntime, handoffProtocol = null, events = null, maxDelegations = 8, clock = () => new Date() } = {}) {
    if (!agentRuntime) throw new TypeError('DelegationEngine requires agentRuntime');
    this.agentRuntime = agentRuntime;
    this.handoffProtocol = handoffProtocol;
    this.events = events;
    this.maxDelegations = maxDelegations;
    this.clock = clock;
  }

  async delegate({ fromAgent = 'team', toAgent, task, input = {}, context = {}, state = null } = {}) {
    const count = Number(context.delegationCount ?? 0);
    if (count >= this.maxDelegations) {
      return { executionId: createExecutionId(), status: 'failed', error: { code: 'DELEGATION_LIMIT', message: `Delegation limit ${this.maxDelegations} exceeded`, retryable: false } };
    }
    const handoff = this.handoffProtocol?.create({ fromAgent, toAgent, task, input, context }) ?? { id: createExecutionId(), fromAgent, toAgent, task, input, context };
    const executionId = createExecutionId();
    this.events?.emit({ type: 'delegation.started', executionId, status: 'started', data: { handoff } });
    try {
      const agent = this.agentRuntime.registry.require(toAgent).manifest;
      const result = await this.agentRuntime.execute(agent, input, { ...context, delegationCount: count + 1, teamState: state });
      const output = { executionId, handoff, result, finishedAt: this.clock().toISOString(), status: result.status };
      this.events?.emit({ type: result.status === 'succeeded' ? 'delegation.completed' : 'delegation.failed', executionId, status: result.status, data: output, error: result.error });
      return output;
    } catch (error) {
      const normalized = { code: error?.code ?? 'DELEGATION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) };
      const output = { executionId, handoff, finishedAt: this.clock().toISOString(), status: 'failed', error: normalized };
      this.events?.emit({ type: 'delegation.failed', executionId, status: 'failed', error: normalized, data: output });
      return output;
    }
  }
}
