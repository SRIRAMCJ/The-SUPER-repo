import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionRecovery, ExecutionStateStore, MissionEngine, TaskDecomposer, TaskGraphExecutor } from '../src/index.js';

const mission = {
  id: 'mission.recoverable', kind: 'mission', name: 'Recoverable', goal: 'recover',
  tasks: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B', dependsOn: ['a'] }
  ]
};

const plan = {
  schemaVersion: '0.1.0', type: 'task-plan', goal: 'recover', taskCount: 1,
  order: ['a'], tasks: [{ id: 'a', title: 'A', dependsOn: [], input: null }]
};

test('MissionEngine passes its state store into an internally created TaskGraphExecutor', async () => {
  const stateStore = new ExecutionStateStore();
  const missionEngine = new MissionEngine({
    workflowEngine: { registry: { require() { throw new Error('workflow path not expected'); } } },
    stateStore,
    taskDecomposer: new TaskDecomposer(),
    taskExecutor: async () => ({ status: 'succeeded', output: 'ok' })
  });
  const result = await missionEngine.execute(mission);
  assert.equal(result.status, 'succeeded');
  assert.notEqual(result.missionExecutionId, result.executionId);
  const missionState = await stateStore.get(result.missionExecutionId);
  const graphState = await stateStore.get(result.executionId);
  assert.equal(missionState.kind, 'mission');
  assert.equal(missionState.childExecutionId, result.executionId);
  assert.equal(graphState.kind, 'task-graph');
  assert.equal(graphState.status, 'succeeded');
});

test('ExecutionRecovery dispatches task-graph states to TaskGraphExecutor', async () => {
  const stateStore = new ExecutionStateStore();
  let calls = 0;
  const graphExecutor = new TaskGraphExecutor({ stateStore, executeTask: async () => {
    calls += 1;
    return { status: 'succeeded', output: 'done' };
  } });
  const first = await graphExecutor.execute(plan);
  assert.equal(first.status, 'succeeded');
  const recovery = new ExecutionRecovery({
    stateStore,
    planExecutor: { async resume() { throw new Error('plan executor must not receive task graph'); } },
    taskGraphExecutor: graphExecutor
  });
  const resumed = await recovery.resume(plan, first.executionId);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(calls, 1);
});

test('ExecutionRecovery reports missing task-graph recovery configuration', async () => {
  const stateStore = new ExecutionStateStore();
  const graphExecutor = new TaskGraphExecutor({ stateStore, executeTask: async () => ({ status: 'failed', error: { code: 'FAIL' } }) });
  const first = await graphExecutor.execute(plan);
  const recovery = new ExecutionRecovery({ stateStore, planExecutor: { async resume() { return { status: 'succeeded' }; } } });
  const result = await recovery.resume(plan, first.executionId);
  assert.equal(result.error.code, 'TASK_GRAPH_RECOVERY_UNAVAILABLE');
});
