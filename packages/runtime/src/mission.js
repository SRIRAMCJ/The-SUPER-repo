export class MissionEngine {
  constructor({ workflowEngine, events = null }) {
    if (!workflowEngine) throw new TypeError('MissionEngine requires workflowEngine');
    this.workflowEngine = workflowEngine;
    this.events = events;
  }

  async execute(mission, input = {}, context = {}) {
    if (!mission || mission.kind !== 'mission') throw new TypeError('A mission capability manifest is required');
    this.events?.emit({ type: 'mission.started', missionId: mission.id, status: 'started', data: { input } });

    const workflowId = mission.workflow ?? mission.execution?.workflow;
    if (!workflowId) throw new Error(`Mission has no workflow: ${mission.id}`);

    const workflow = this.workflowEngine.registry.require(workflowId).manifest;
    const result = await this.workflowEngine.execute(workflow, input, context);
    this.events?.emit({ type: `mission.${result.status === 'succeeded' ? 'completed' : 'failed'}`, missionId: mission.id, status: result.status, data: result });
    return { missionId: mission.id, ...result };
  }
}
