import { createExecutionId } from './events.js';
import { SharedContext } from './shared-context.js';
import { TeamExecutionCoordinator } from './team-coordinator.js';

export class TeamRuntime {
  constructor({ registry, agentRuntime, delegationEngine, coordinator = null, events = null, clock = () => new Date() } = {}) {
    if (!registry || !agentRuntime || !delegationEngine) throw new TypeError('TeamRuntime requires registry, agentRuntime and delegationEngine');
    this.registry = registry;
    this.agentRuntime = agentRuntime;
    this.delegationEngine = delegationEngine;
    this.events = events;
    this.clock = clock;
    this.coordinator = coordinator ?? new TeamExecutionCoordinator({ delegationEngine, events, clock });
  }

  async execute(team, input = {}, context = {}, options = {}) {
    if (!team || team.kind !== 'team') throw new TypeError('A team capability manifest is required');
    const executionId = createExecutionId();
    const startedAt = this.clock().toISOString();
    const members = Array.isArray(team.members) ? team.members : [];
    if (!members.length) return this.#fail(executionId, startedAt, 'TEAM_EMPTY', `Team has no members: ${team.id}`);
    this.events?.emit({ type: 'team.started', executionId, teamId: team.id, status: 'started', data: { memberCount: members.length } });
    const sharedContext = new SharedContext(context.teamState ?? {}, { clock: this.clock });
    try {
      const execution = await this.coordinator.execute({
        team,
        members,
        input,
        context: { ...context, executionId },
        sharedContext,
        strategy: options.strategy ?? team.execution?.strategy ?? 'sequential',
        maxConcurrency: options.maxConcurrency ?? team.execution?.maxConcurrency ?? 4,
        failFast: options.failFast ?? team.execution?.failFast ?? true
      });
      const failed = execution.results.some((result) => result.status !== 'succeeded');
      const output = { executionId, teamId: team.id, startedAt, finishedAt: this.clock().toISOString(), status: failed ? 'failed' : 'succeeded', strategy: execution.strategy, results: execution.results, sharedContext: execution.context };
      this.events?.emit({ type: failed ? 'team.failed' : 'team.completed', executionId, teamId: team.id, status: output.status, data: output, error: failed ? { code: 'TEAM_MEMBER_FAILED', message: 'One or more team members did not succeed', retryable: false } : undefined });
      return output;
    } catch (error) {
      return this.#fail(executionId, startedAt, error?.code ?? 'TEAM_ERROR', error?.message ?? String(error));
    }
  }

  #fail(executionId, startedAt, code, message, extra = {}) {
    const output = { executionId, startedAt, finishedAt: this.clock().toISOString(), status: 'failed', error: { code, message, retryable: false }, ...extra };
    this.events?.emit({ type: 'team.failed', executionId, status: 'failed', error: output.error, data: output });
    return output;
  }
}
