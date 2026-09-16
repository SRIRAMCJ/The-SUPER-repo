export class MissionEngine {
  constructor({ workflowEngine, teamRuntime = null, events = null, memory = null, clock = () => new Date() }) {
    if (!workflowEngine) throw new TypeError('MissionEngine requires workflowEngine');
    this.workflowEngine = workflowEngine;
    this.teamRuntime = teamRuntime;
    this.events = events;
    this.memory = memory;
    this.clock = clock;
  }

  async execute(mission, input = {}, context = {}) {
    if (!mission || mission.kind !== 'mission') throw new TypeError('A mission capability manifest is required');
    const startedAt = this.clock().toISOString();
    this.events?.emit({ type: 'mission.started', missionId: mission.id, status: 'started', data: { input } });

    try {
      const result = mission.team && this.teamRuntime
        ? await this.teamRuntime.execute(this.workflowEngine.registry.require(mission.team).manifest, input, context)
        : await this.executeWorkflow(mission, input, context);
      const missionResult = { missionId: mission.id, startedAt, finishedAt: this.clock().toISOString(), ...result };
      const type = result.status === 'succeeded' ? 'mission.completed' : 'mission.failed';
      this.events?.emit({ type, missionId: mission.id, status: result.status, data: missionResult, error: result.error });
      this.memory?.append({ type: 'mission-execution', missionId: mission.id, status: result.status, executionId: result.executionId ?? result.workflowExecutionId ?? null, result: missionResult });
      return missionResult;
    } catch (error) {
      const normalized = normalizeMissionError(error);
      const missionResult = { missionId: mission.id, startedAt, finishedAt: this.clock().toISOString(), status: 'failed', error: normalized };
      this.events?.emit({ type: 'mission.failed', missionId: mission.id, status: 'failed', error: normalized, data: missionResult });
      this.memory?.append({ type: 'mission-execution', missionId: mission.id, status: 'failed', executionId: null, result: missionResult });
      return missionResult;
    }
  }

  async executeWorkflow(mission, input, context) {
    const workflowId = mission.workflow ?? mission.execution?.workflow;
    if (!workflowId) throw Object.assign(new Error(`Mission has no workflow: ${mission.id}`), { code: 'MISSION_WORKFLOW_MISSING' });
    const workflow = this.workflowEngine.registry.require(workflowId).manifest;
    return this.workflowEngine.execute(workflow, input, context);
  }
}

function normalizeMissionError(error) {
  return { code: error?.code ?? 'MISSION_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) };
}
