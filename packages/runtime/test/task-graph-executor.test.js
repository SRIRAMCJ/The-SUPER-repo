import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraphExecutor } from '../src/task-graph-executor.js';

function plan() {
  return {
    schemaVersion: '0.1.0', type: 'task-plan', goal: 'build', taskCount: 4,
    order: ['a', 'b', 'c', 'd'],
    tasks: [
      { id: 'a', title: 'A', dependsOn: [], input: null },
      { id: 'b', title: 'B', dependsOn: ['a'], input: null },
      { id: 'c', title: 'C', dependsOn: ['a'], input: null },
      { id: 'd', title: 'D', dependsOn: ['b', 'c'], input: null }
    ]
  };
}

test('executes dependencies before dependents and exposes prior results', async () => {
  const calls = [];
  const executor = new TaskGraphExecutor({ executeTask: async (task, input, context) => {
    calls.push(task.id);
    if (task.id === 'd') assert.deepEqual(Object.keys(context.taskResults).sort(), ['a', 'b', 'c']);
    return { status: 'succeeded', output: task.id };
  } });
  const result = await executor.execute(plan(), { seed: true }, { executionId: 'x' }, { strategy: 'parallel', maxConcurrency: 2 });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
  assert.deepEqual(result.results.map((item) => item.taskId), ['a', 'b', 'c', 'd']);
  assert.equal(result.output, 'd');
});

test('blocks dependents after dependency failure', async () => {
  const calls = [];
  const executor = new TaskGraphExecutor({ executeTask: async (task) => {
    calls.push(task.id);
    if (task.id === 'a') return { status: 'failed', error: { code: 'A_FAILED' } };
    return { status: 'succeeded' };
  } });
  const result = await executor.execute(plan(), {}, { executionId: 'x' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, ['a']);
  assert.equal(result.results.find((item) => item.taskId === 'a').error.code, 'A_FAILED');
  assert.equal(result.results.find((item) => item.taskId === 'b').status, 'skipped');
  assert.equal(result.results.find((item) => item.taskId === 'c').status, 'skipped');
  assert.equal(result.results.find((item) => item.taskId === 'd').status, 'skipped');
});

test('enforces bounded parallelism', async () => {
  let active = 0;
  let peak = 0;
  const executor = new TaskGraphExecutor({ executeTask: async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { status: 'succeeded' };
  } });
  const result = await executor.execute({ ...plan(), tasks: plan().tasks.slice(0, 3), order: ['a', 'b', 'c'], taskCount: 3 }, {}, { executionId: 'x' }, { strategy: 'parallel', maxConcurrency: 2 });
  assert.equal(result.status, 'succeeded');
  assert.ok(peak <= 2);
});

test('preserves completed work when fail-fast stops later scheduling', async () => {
  const executor = new TaskGraphExecutor({ executeTask: async (task) => task.id === 'b' ? { status: 'failed', error: { code: 'B_FAILED' } } : { status: 'succeeded', output: task.id } });
  const result = await executor.execute({ ...plan(), tasks: [plan().tasks[0], plan().tasks[1], plan().tasks[2]], order: ['a', 'b', 'c'], taskCount: 3 }, {}, { executionId: 'x' }, { failFast: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.results.find((item) => item.taskId === 'a').status, 'succeeded');
  assert.equal(result.results.find((item) => item.taskId === 'b').status, 'failed');
  assert.equal(result.results.find((item) => item.taskId === 'c').error.code, 'TASK_FAIL_FAST');
});

test('rejects malformed plans and invalid execution options', async () => {
  const executor = new TaskGraphExecutor({ executeTask: async () => ({ status: 'succeeded' }) });
  await assert.rejects(() => executor.execute({ type: 'task-plan', schemaVersion: '0.1.0', tasks: [], order: [], taskCount: 1 }), { code: 'TASK_PLAN_INVALID' });
  await assert.rejects(() => executor.execute(plan(), {}, {}, { strategy: 'random' }), { code: 'TASK_STRATEGY_INVALID' });
  await assert.rejects(() => executor.execute(plan(), {}, {}, { maxConcurrency: 0 }), { code: 'TASK_CONCURRENCY_INVALID' });
  await assert.rejects(() => executor.execute({ ...plan(), order: ['b', 'a', 'c', 'd'] }), { code: 'TASK_PLAN_INVALID' });
});

test('normalizes executor throws and explicit skipped results', async () => {
  const executor = new TaskGraphExecutor({ executeTask: async (task) => {
    if (task.id === 'a') throw Object.assign(new Error('boom'), { code: 'BOOM', retryable: true });
    return { status: 'skipped', error: { code: 'NOT_NEEDED' } };
  } });
  const result = await executor.execute({ ...plan(), tasks: [plan().tasks[0]], order: ['a'], taskCount: 1 }, {}, { executionId: 'x' });
  assert.equal(result.status, 'failed');
  assert.equal(result.results[0].error.code, 'BOOM');
  assert.equal(result.results[0].error.retryable, true);
});
