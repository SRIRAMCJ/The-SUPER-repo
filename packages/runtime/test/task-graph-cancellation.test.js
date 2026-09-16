import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionCancellationRegistry, TaskGraphExecutor } from '../src/index.js';

const plan = {
  schemaVersion: '0.1.0', type: 'task-plan', goal: 'cancel', taskCount: 2,
  order: ['a', 'b'],
  tasks: [
    { id: 'a', title: 'A', dependsOn: [], input: null },
    { id: 'b', title: 'B', dependsOn: ['a'], input: null }
  ]
};

test('cancels an active task graph and propagates AbortSignal', async () => {
  const cancellation = new ExecutionCancellationRegistry();
  let executionId;
  let sawAbort = false;
  const executor = new TaskGraphExecutor({ cancellation, executeTask: async (task, input, context) => {
    executionId = context.executionId;
    if (task.id === 'a') {
      await new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => { sawAbort = true; reject(context.signal.reason); }, { once: true });
      });
    }
    return { status: 'succeeded', output: task.id };
  } });

  const running = executor.execute(plan);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(executor.cancel(executionId, 'stop now'), true);
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.code, 'EXECUTION_CANCELLED');
  assert.equal(sawAbort, true);
  assert.equal(cancellation.has(executionId), false);
});

test('returns false when cancelling an unknown graph execution', () => {
  const executor = new TaskGraphExecutor({ executeTask: async () => ({ status: 'succeeded' }) });
  assert.equal(executor.cancel('does-not-exist'), false);
});

test('persists cancellation as a terminal execution state', async () => {
  const { ExecutionStateStore } = await import('../src/state.js');
  const stateStore = new ExecutionStateStore();
  const cancellation = new ExecutionCancellationRegistry();
  let executionId;
  const executor = new TaskGraphExecutor({ stateStore, cancellation, executeTask: async (task, input, context) => {
    executionId = context.executionId;
    if (task.id === 'a') await new Promise((resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    return { status: 'succeeded' };
  } });
  const running = executor.execute(plan);
  await new Promise((resolve) => setTimeout(resolve, 5));
  executor.cancel(executionId);
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal((await stateStore.get(executionId)).status, 'cancelled');
});
