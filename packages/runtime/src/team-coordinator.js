export class TeamExecutionCoordinator {
  constructor({ delegationEngine, events = null, clock = () => new Date() } = {}) {
    if (!delegationEngine) throw new TypeError('TeamExecutionCoordinator requires delegationEngine');
    this.delegationEngine = delegationEngine;
    this.events = events;
    this.clock = clock;
  }

  async execute({ team, members, input, context, sharedContext, strategy = 'sequential', maxConcurrency = 4, failFast = true } = {}) {
    if (!Array.isArray(members) || !members.length) throw new TypeError('TeamExecutionCoordinator requires team members');
    const normalizedStrategy = strategy === 'parallel' ? 'parallel' : 'sequential';
    const concurrency = Math.max(1, Math.min(Number(maxConcurrency) || 1, members.length));
    this.events?.emit({ type: 'team.execution.started', executionId: context.executionId, teamId: team.id, status: 'started', data: { strategy: normalizedStrategy, maxConcurrency: concurrency } });

    const executeMember = async (member, index) => {
      const agentId = typeof member === 'string' ? member : member.agent;
      if (!agentId) return { index, status: 'failed', error: { code: 'TEAM_MEMBER_INVALID', message: 'Team member must identify an agent', retryable: false } };
      const task = typeof member === 'string' ? team.task ?? `Execute team task for ${team.name}` : member.task ?? team.task ?? `Execute assigned role for ${team.name}`;
      const snapshot = sharedContext.snapshot();
      this.events?.emit({ type: 'team.member.started', executionId: context.executionId, teamId: team.id, status: 'started', data: { agentId, index, contextVersion: snapshot.version } });
      const delegated = await this.delegationEngine.delegate({
        fromAgent: team.id,
        toAgent: agentId,
        task,
        input,
        context: { ...context, sharedContext: snapshot.values },
        state: { teamId: team.id, memberIndex: index, contextVersion: snapshot.version }
      });
      const result = { index, agentId, task, ...delegated };
      const patch = { [`agent:${agentId}`]: delegated.result ?? delegated };
      let committed = false;
      let conflict = null;
      for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
        const targetVersion = attempt === 0 ? snapshot.version : sharedContext.snapshot().version;
        try {
          sharedContext.commit(patch, { expectedVersion: targetVersion, actor: agentId, reason: 'team-member-result' });
          committed = true;
        } catch (error) {
          conflict = error;
          if (error.code !== 'CONTEXT_VERSION_CONFLICT') break;
        }
      }
      if (!committed) result.contextConflict = { code: conflict?.code ?? 'CONTEXT_COMMIT_FAILED', message: conflict?.message ?? 'Shared context commit failed', retryable: Boolean(conflict?.retryable) };
      this.events?.emit({ type: result.status === 'succeeded' ? 'team.member.completed' : 'team.member.failed', executionId: context.executionId, teamId: team.id, status: result.status, data: result, error: result.error });
      return result;
    };

    if (normalizedStrategy === 'sequential') {
      const results = [];
      for (let index = 0; index < members.length; index += 1) {
        const result = await executeMember(members[index], index);
        results.push(result);
        if (failFast && result.status !== 'succeeded') break;
      }
      return { strategy: normalizedStrategy, results, context: sharedContext.snapshot() };
    }

    const results = new Array(members.length);
    let nextIndex = 0;
    let stopScheduling = false;
    const worker = async () => {
      while (!stopScheduling) {
        const index = nextIndex++;
        if (index >= members.length) return;
        const result = await executeMember(members[index], index);
        results[index] = result;
        if (failFast && result.status !== 'succeeded') stopScheduling = true;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    for (let index = 0; index < members.length; index += 1) {
      if (!results[index]) results[index] = { index, status: 'cancelled', error: { code: 'TEAM_FAIL_FAST', message: 'Member was not started because fail-fast stopped scheduling', retryable: false } };
    }
    return { strategy: normalizedStrategy, results, context: sharedContext.snapshot() };
  }
}
