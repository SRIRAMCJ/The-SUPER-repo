import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/registry.js';
import { RuntimeLifecycleManager } from '../src/lifecycle.js';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';
import { RuntimeShutdownCoordinator } from '../src/shutdown-coordinator.js';
import { RuntimeReadinessKernel } from '../src/readiness.js';
import { ToolRuntime } from '../src/tool-runtime.js';

function setup(handler) {
  const calls = [];
  const lifecycle = new RuntimeLifecycleManager({ components: [{ name: 'worker', start: () => calls.push('start'), stop: () => calls.push('stop') }] });
  const admission = new RuntimeShutdownAdmission();
  const coordinator = new RuntimeShutdownCoordinator({ lifecycle, admission });
  const registry = new CapabilityRegistry();
  registry.register({ schemaVersion: '0.1.0', id: 'tool/work', kind: 'tool', name: 'Work', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' } }, handler);
  return { calls, lifecycle, admission, coordinator, tool: new ToolRuntime({ registry, shutdownAdmission: admission }) };
}

test('startup opens admission only after components start; shutdown waits before stopping', async () => {
  let finish;
  const { calls, lifecycle, admission, coordinator, tool } = setup(() => new Promise((resolve) => { finish = resolve; }));
  assert.equal((await tool.execute('tool/work', {}, { executionId: 'early' })).error.code, 'ADMISSION_CLOSED');
  await coordinator.start();
  assert.deepEqual(calls, ['start']);
  const work = tool.execute('tool/work', {}, { executionId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = coordinator.shutdown({ deadlineMs: 1000 });
  assert.equal(admission.state(), 'draining');
  assert.equal((await tool.execute('tool/work', {}, { executionId: 'late' })).error.code, 'ADMISSION_CLOSED');
  assert.deepEqual(calls, ['start']);
  assert.equal((await new RuntimeReadinessKernel({ lifecycle }).evaluate()).state, 'draining');
  finish('done');
  assert.equal((await work).status, 'succeeded');
  assert.equal((await shutdown).lifecycle.state, 'stopped');
  assert.deepEqual(calls, ['start', 'stop']);
  await coordinator.start();
  assert.equal(admission.state(), 'accepting');
});

test('deadline leaves components running and gate closed until active work settles', async () => {
  let finish;
  const { calls, admission, coordinator, tool } = setup(() => new Promise((resolve) => { finish = resolve; }));
  await coordinator.start();
  const work = tool.execute('tool/work', {}, { executionId: 'active' });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(coordinator.shutdown({ deadlineMs: 0 }), { code: 'DRAIN_DEADLINE_EXCEEDED' });
  assert.deepEqual(calls, ['start']);
  assert.equal(admission.state(), 'draining');
  finish('done');
  await work;
  assert.equal((await coordinator.shutdown()).lifecycle.state, 'stopped');
  assert.deepEqual(calls, ['start', 'stop']);
});

test('concurrent shutdown callers share one stop, and startup failures stay closed', async () => {
  const { calls, coordinator, admission } = setup(async () => 'done');
  await coordinator.start();
  const first = coordinator.shutdown();
  const second = coordinator.shutdown();
  assert.equal(first, second);
  await first;
  assert.deepEqual(calls, ['start', 'stop']);
  assert.equal(admission.state(), 'stopped');

  const lifecycle = new RuntimeLifecycleManager({ components: [{ name: 'broken', start: () => { throw new Error('offline'); } }] });
  const gate = new RuntimeShutdownAdmission();
  const failed = new RuntimeShutdownCoordinator({ lifecycle, admission: gate });
  await assert.rejects(failed.start(), /offline/);
  assert.equal(gate.state(), 'stopped');
});
