import { createExecutionId } from './events.js';
import { TaskGraphExecutor } from './task-graph-executor.js';

export class MissionEngine {
  constructor({ workflowEngine, teamRuntime = null, events = null, memory = null, clock = () => new Date(), stateStore = null, taskDecomposer = null, taskGraphExecutor = null, taskExecutor = null }) {
    if (!workflowEngine) throw new TypeError('MissionEngine requires workflowEngine');
    if (taskGraphExecutor && typeof taskGraphExecutor.execute !== 'function') throw new TypeError('MissionEngine taskGraphExecutor must expose execute');
    if (taskExecutor !== null && typeof taskExecutor !== 'function') throw new TypeError('MissionEngine taskExecutor must be a function');
    if (taskExecutor && taskGraphExecutor) throw new TypeError('MissionEngine accepts either taskGraphExecutor or taskExecutor, not both');
    if (taskDecomposer && !taskGraphExecutor && !taskExecutor) throw new TypeError('MissionEngine task execution requires taskExecutor or taskGraphExecutor');

    this.workflowEngine = workflowEngine;
    this.teamRuntime = teamRuntime;
    this.events = events;
    this.memory = memory;
    this.clock = clock;
    this.stateStore = stateStore;
    this.taskDecomposer = taskDecomposer;
    this.taskGraphExecutor = taskGraphExecutor ?? (taskExecutor ? new TaskGraphExecutor({ executeTask: taskExecutor, events, clock }) : null);
  }

  async execute(mission, input = {}, context = {}) {
    if (!mission || mission.kind !== 'mission') throw new TypeError('A mission capability manifest is required');
    const missionExecutionId = createExecutionId();
    const startedAt = this.clock().toISOString();
    if (this.stateStore) await this.stateStore.create({ schemaVersion: '0.1.0', type: 'execution-state', executionId: missionExecutionId, kind: 'mission', missionId: mission.id, status: 'running', input, startedAt, attempt: 1 });
    this.events?.emit({ type: 'mission.started', missionId: mission.id, missionExecutionId, status: 'started', data: { input } });

    try {
      let result;
      if (mission.tasks !== undefined) {
        if (!this.taskDecomposer || !this.taskGraphExecutor) throw Object.assign(new Error(`Mission requires task graph runtime: ${mission.id}`), { code: 'TASK_GRAPH_RUNTIME_UNAVAILABLE', retryable: false });
        const taskPlan = this.taskDecomposer.decompose({ goal: mission.goal ?? mission.task ?? mission.name ?? mission.id, tasks: mission.tasks });
        result = await this.taskGraphExecutor.execute(taskPlan, input, { ...context, missionExecutionId }, mission.execution ?? {});
      } else if (mission.team) {
        if (!this.teamRuntime) throw Object.assign(new Error(`Mission requires team runtime: ${mission.team}`), { code: 'TEAM_RUNTIME_UNAVAILABLE' });
        const team = this.workflowEngine.registry.require(mission.team).manifest;
        result = await this.teamRuntime.execute(team, input, { ...context, missionExecutionId });
      } else {
        result = await this.executeWorkflow(mission, input, { ...context, missionExecutionId });
      }
      const missionResult = { missionId: mission.id, missionExecutionId, startedAt, finishedAt: this.clock().toISOString(), ...result };
      const type = result.status === 'succeeded' ? 'mission.completed' : 'mission.failed';
      if (this.stateStore) await this.stateStore.update(missionExecutionId, { status: result.status, childExecutionId: result.executionId ?? result.workflowExecutionId ?? null, result: missionResult, finishedAt: missionResult.finishedAt, error: result.error ?? null }, undefined);
      this.events?.emit({ type, missionId: mission.id, missionExecutionId, status: result.status, data: missionResult, error: result.error });
      this.memory?.append({ type: 'mission-execution', missionId: mission.id, status: result.status, executionId: missionExecutionId, childExecutionId: result.executionId ?? result.workflowExecutionId ?? null, result: missionResult });
      return missionResult;
    } catch (error) {
      const normalized = normalizeMissionError(error);
      const missionResult = { missionId: mission.id, missionExecutionId, startedAt, finishedAt: this.clock().toISOString(), status: 'failed', error: normalized };
      if (this.stateStore) await this.stateStore.update(missionExecutionId, { status: 'failed', result: missionResult, finishedAt: missionResult.finishedAt, error: normalized }, undefined);
      this.events?.emit({ type: 'mission.failed', missionId: mission.id, missionExecutionId, status: 'failed', error: normalized, data: missionResult });
      this.memory?.append({ type: 'mission-execution', missionId: mission.id, status: 'failed', executionId: missionExecutionId, childExecutionId: null, result: missionResult });
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
