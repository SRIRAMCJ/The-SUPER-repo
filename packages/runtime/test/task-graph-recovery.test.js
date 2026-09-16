import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraphExecutor } from '../src/task-graph-executor.js';
import { ExecutionStateStore } from '../src/state.js';

const plan = {
  schemaVersion: '0.1.0', type: 'task-plan', goal: 'recoverable build', taskCount: 3,
  order: ['a', 'b', 'c'],
  tasks: [
    { id: 'a', title: 'A', dependsOn: [], input: null },
    { id: 'b', title: 'B', dependsOn: ['a'], input: null },
    { id: 'c', title: 'C', dependsOn: ['b'], input: null }
  ]
};

test('persists a failed graph and resumes only unfinished tasks', async () => {
  const stateStore = new ExecutionStateStore();
  let fail = true;
  const calls = [];
  const executor = new TaskGraphExecutor({ stateStore, executeTask: async (task) => {
    calls.push(task.id);
    if (task.id === 'b' && fail) return { status: 'failed', error: { code: 'B_FAILED' } };
    return { status: 'succeeded', output: task.id };
  } });

  const first = await executor.execute(plan);
  assert.equal(first.status, 'failed');
  assert.deepEqual(calls, ['a', 'b']);
  const saved = await stateStore.get(first.executionId);
  assert.equal(saved.kind, 'task-graph');
  assert.equal(saved.status, 'failed');
  assert.equal(saved.results.find((r) => r.taskId === 'a').status, 'succeeded');

  fail = false;
  const resumed = await executor.resume(plan, first.executionId);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.attempt, 2);
  assert.deepEqual(calls, ['a', 'b', 'b', 'c']);
  assert.equal((await stateStore.get(first.executionId)).status, 'succeeded');
});

test('claims recovery with optimistic concurrency and validates the plan', async () => {
  const stateStore = new ExecutionStateStore();
  const executor = new TaskGraphExecutor({ stateStore, executeTask: async () => ({ status: 'failed', error: { code: 'FAIL' } }) });
  const first = await executor.execute(plan);
  const running = await stateStore.update(first.executionId, { status: 'running' });
  const blocked = await executor.resume(plan, first.executionId);
  assert.equal(blocked.error.code, 'EXECUTION_ALREADY_RUNNING');
  await stateStore.update(first.executionId, { status: 'failed' }, running.version);
  const mismatch = await executor.resume({ ...plan, goal: 'different' }, first.executionId);
  assert.equal(mismatch.error.code, 'EXECUTION_STATE_PLAN_MISMATCH');
});

test('requires state storage for recovery', async () => {
  const executor = new TaskGraphExecutor({ executeTask: async () => ({ status: 'succeeded' }) });
  await assert.rejects(() => executor.resume(plan, 'missing'), { code: 'EXECUTION_STATE_UNAVAILABLE' });
});
