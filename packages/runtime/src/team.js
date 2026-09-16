import { createExecutionId } from './events.js';
import { SharedContext } from './shared-context.js';
import { TeamExecutionCoordinator } from './team-coordinator.js';

export class TeamRuntime {
  constructor({ registry, agentRuntime, delegationEngine, coordinator = null, reflection = null, events = null, clock = () => new Date() } = {}) {
    if (!registry || !agentRuntime || !delegationEngine) throw new TypeError('TeamRuntime requires registry, agentRuntime and delegationEngine');
    this.registry = registry;
    this.agentRuntime = agentRuntime;
    this.delegationEngine = delegationEngine;
    this.reflection = reflection;
    this.events = events;
    this.clock = clock;
    this.coordinator = coordinator ?? new TeamExecutionCoordinator({ delegationEngine, events, clock });
  }

  async execute(team, input = {}, context = {}, options = {}) {
    if (!team || team.kind !== 'team') throw new TypeError('A team capability manifest is required');
    const executionId = createExecutionId();
    const startedAt = this.clock().toISOString();
    const members = Array.isArray(team.members) ? team.members : [];
    if (!members.length) return this.#fail(executionId, team.id, startedAt, 'TEAM_EMPTY', `Team has no members: ${team.id}`);
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
      const synthesis = failed ? null : synthesizeResults(execution.results, execution.context);
      const reflection = this.reflection
        ? await this.reflection.evaluate({ request: team.task ?? team.name, result: { status: failed ? 'failed' : 'succeeded', results: execution.results, sharedContext: execution.context }, context })
        : null;
      const reflectionRejected = reflection?.status === 'rejected';
      const status = failed || reflectionRejected ? 'failed' : 'succeeded';
      const output = { executionId, teamId: team.id, startedAt, finishedAt: this.clock().toISOString(), status, strategy: execution.strategy, results: execution.results, sharedContext: execution.context, synthesis, reflection };
      this.events?.emit({ type: status === 'succeeded' ? 'team.completed' : 'team.failed', executionId, teamId: team.id, status, data: output, error: status === 'failed' ? { code: reflectionRejected ? 'TEAM_REFLECTION_REJECTED' : 'TEAM_MEMBER_FAILED', message: reflectionRejected ? 'Team output was rejected by reflection' : 'One or more team members did not succeed', retryable: false } : undefined });
      return output;
    } catch (error) {
      return this.#fail(executionId, team.id, startedAt, error?.code ?? 'TEAM_ERROR', error?.message ?? String(error));
    }
  }

  #fail(executionId, teamId, startedAt, code, message, extra = {}) {
    const output = { executionId, teamId, startedAt, finishedAt: this.clock().toISOString(), status: 'failed', error: { code, message, retryable: false }, ...extra };
    this.events?.emit({ type: 'team.failed', executionId, teamId, status: 'failed', error: output.error, data: output });
    return output;
  }
}

function synthesizeResults(results, context) {
  return {
    schemaVersion: '0.1.0',
    type: 'team-synthesis',
    memberCount: results.length,
    successfulMembers: results.filter((result) => result.status === 'succeeded').map((result) => result.agentId),
    outputs: results.map((result) => ({ agentId: result.agentId, task: result.task, output: result.result?.output ?? result.result ?? null })),
    contextVersion: context.version
  };
}
