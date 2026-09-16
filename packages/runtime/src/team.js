import { createExecutionId } from './events.js';

export class TeamRuntime {
  constructor({ registry, agentRuntime, delegationEngine, events = null, clock = () => new Date() } = {}) {
    if (!registry || !agentRuntime || !delegationEngine) throw new TypeError('TeamRuntime requires registry, agentRuntime and delegationEngine');
    this.registry = registry;
    this.agentRuntime = agentRuntime;
    this.delegationEngine = delegationEngine;
    this.events = events;
    this.clock = clock;
  }

  async execute(team, input = {}, context = {}, options = {}) {
    if (!team || team.kind !== 'team') throw new TypeError('A team capability manifest is required');
    const executionId = createExecutionId();
    const startedAt = this.clock().toISOString();
    const members = Array.isArray(team.members) ? team.members : [];
    if (!members.length) return this.#fail(executionId, startedAt, 'TEAM_EMPTY', `Team has no members: ${team.id}`);
    this.events?.emit({ type: 'team.started', executionId, teamId: team.id, status: 'started', data: { memberCount: members.length } });
    const results = [];
    const state = { ...(context.teamState ?? {}), teamId: team.id, results };
    try {
      for (const member of members) {
        const agentId = typeof member === 'string' ? member : member.agent;
        if (!agentId) return this.#fail(executionId, startedAt, 'TEAM_MEMBER_INVALID', 'Team member must identify an agent', { results });
        const task = typeof member === 'string' ? team.task ?? `Execute team task for ${team.name}` : member.task ?? team.task ?? `Execute assigned role for ${team.name}`;
        const delegated = await this.delegationEngine.delegate({ fromAgent: team.id, toAgent: agentId, task, input, context, state });
        results.push({ agentId, task, ...delegated });
        if (delegated.status !== 'succeeded' && options.failFast !== false) {
          return this.#fail(executionId, startedAt, 'TEAM_MEMBER_FAILED', `Team member failed: ${agentId}`, { results });
        }
        state.results = results;
      }
      const output = { executionId, teamId: team.id, startedAt, finishedAt: this.clock().toISOString(), status: 'succeeded', results };
      this.events?.emit({ type: 'team.completed', executionId, teamId: team.id, status: 'succeeded', data: output });
      return output;
    } catch (error) {
      return this.#fail(executionId, startedAt, error?.code ?? 'TEAM_ERROR', error?.message ?? String(error), { results });
    }
  }

  #fail(executionId, startedAt, code, message, extra = {}) {
    const output = { executionId, startedAt, finishedAt: this.clock().toISOString(), status: 'failed', error: { code, message, retryable: false }, ...extra };
    this.events?.emit({ type: 'team.failed', executionId, status: 'failed', error: output.error, data: output });
    return output;
  }
}
