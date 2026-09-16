import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionEngine } from '../src/mission.js';
import { TaskDecomposer } from '../src/index.js';

test('MissionEngine executes explicit task graphs through the supplied task executor', async () => {
  const calls = [];
  const engine = new MissionEngine({
    workflowEngine: { registry: { require() { throw new Error('workflow must not be selected'); } } },
    taskDecomposer: new TaskDecomposer({ clock: () => new Date('2026-01-01T00:00:00Z') }),
    taskExecutor: async (task, input, context) => {
      calls.push({ id: task.id, input, taskResults: Object.keys(context.taskResults) });
      return { status: 'succeeded', output: task.title };
    },
    clock: () => new Date('2026-01-01T00:00:00Z')
  });

  const result = await engine.execute({
    id: 'mission.build', kind: 'mission', name: 'Build', goal: 'Build safely',
    tasks: [
      { id: 'compile', title: 'Compile' },
      { id: 'test', title: 'Test', dependsOn: ['compile'] }
    ]
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, [
    { id: 'compile', input: {}, taskResults: [] },
    { id: 'test', input: {}, taskResults: ['compile'] }
  ]);
  assert.equal(result.type, 'task-graph-execution');
  assert.equal(result.goal, 'Build safely');
});

test('MissionEngine reports unavailable task graph runtime', async () => {
  const engine = new MissionEngine({ workflowEngine: { registry: { require() {} } } });
  const result = await engine.execute({ id: 'mission.tasks', kind: 'mission', tasks: [{ id: 'a', title: 'A' }] });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'TASK_GRAPH_RUNTIME_UNAVAILABLE');
});

test('MissionEngine rejects conflicting task executor configuration', () => {
  assert.throws(() => new MissionEngine({
    workflowEngine: {},
    taskDecomposer: new TaskDecomposer(),
    taskExecutor: async () => ({ status: 'succeeded' }),
    taskGraphExecutor: { execute() {} }
  }), { message: 'MissionEngine accepts either taskGraphExecutor or taskExecutor, not both' });
});
