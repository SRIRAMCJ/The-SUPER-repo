import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionEngine } from '../src/mission.js';
import { TaskDecomposer, TaskGraphExecutor } from '../src/index.js';

test('MissionEngine executes explicit task graphs before team/workflow routing', async () => {
  const calls = [];
  const graphExecutor = new TaskGraphExecutor({ executeTask: async (task) => {
    calls.push(task.id);
    return { status: 'succeeded', output: task.title };
  } });
  const engine = new MissionEngine({
    workflowEngine: { registry: { require() { throw new Error('workflow must not be selected'); } } },
    taskDecomposer: new TaskDecomposer({ clock: () => new Date('2026-01-01T00:00:00Z') }),
    taskGraphExecutor: graphExecutor,
    taskExecutor: async () => ({ status: 'succeeded' }),
    clock: () => new Date('2026-01-01T00:00:00Z')
  });

  const result = await engine.execute({
    id: 'mission.build', kind: 'mission', name: 'Build',
    tasks: [
      { id: 'compile', title: 'Compile' },
      { id: 'test', title: 'Test', dependsOn: ['compile'] }
    ]
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, ['compile', 'test']);
  assert.equal(result.type, 'task-graph-execution');
});

test('MissionEngine reports unavailable task graph runtime', async () => {
  const engine = new MissionEngine({ workflowEngine: { registry: { require() {} } } });
  const result = await engine.execute({ id: 'mission.tasks', kind: 'mission', tasks: [{ id: 'a', title: 'A' }] });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'TASK_GRAPH_RUNTIME_UNAVAILABLE');
});
