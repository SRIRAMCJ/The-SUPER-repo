import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraphExecutor } from '../src/task-graph-executor.js';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';
import { ExecutionStateStore } from '../src/state.js';

const plan = { schemaVersion: '0.1.0', type: 'task-plan', goal: 'work', taskCount: 1, order: ['a'], tasks: [{ id: 'a', title: 'A', dependsOn: [], input: null }] };

test('drain retains a graph lease after cancellation until its task settles', async () => {
  let finish;
  const gate = new RuntimeShutdownAdmission();
  const executor = new TaskGraphExecutor({ shutdownAdmission: gate, executeTask: () => new Promise((resolve) => { finish = resolve; }) });
  const work = executor.execute(plan, {}, { executionId: 'graph' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.cancel('graph'), true);
  assert.equal((await work).status, 'cancelled');
  assert.deepEqual(gate.activeExecutions(), ['graph']);
  gate.beginDrain({ deadlineMs: 1000 });
  assert.equal((await executor.execute(plan, {}, { executionId: 'late' })).error.code, 'ADMISSION_CLOSED');
  const drained = gate.waitForDrain();
  finish({ status: 'succeeded' });
  assert.equal((await drained).state, 'stopped');
});

test('resume checks admission before claiming state', async () => {
  const gate = new RuntimeShutdownAdmission();
  const stateStore = new ExecutionStateStore();
  const executor = new TaskGraphExecutor({ shutdownAdmission: gate, stateStore, executeTask: async () => ({ status: 'failed', error: { code: 'FAIL' } }) });
  const first = await executor.execute(plan, {}, { executionId: 'graph' });
  const before = await stateStore.get('graph');
  gate.beginDrain();
  const denied = await executor.resume(plan, 'graph');
  assert.equal(denied.error.code, 'ADMISSION_CLOSED');
  assert.equal((await stateStore.get('graph')).version, before.version);
  assert.equal(first.status, 'failed');
});

test('handler rejection releases the lease', async () => {
  const gate = new RuntimeShutdownAdmission();
  const executor = new TaskGraphExecutor({ shutdownAdmission: gate, executeTask: async () => { throw new Error('failure'); } });
  assert.equal((await executor.execute(plan, {}, { executionId: 'failed' })).status, 'failed');
  assert.deepEqual(gate.activeExecutions(), []);
});
