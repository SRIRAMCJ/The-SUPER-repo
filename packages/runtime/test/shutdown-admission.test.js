import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/registry.js';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';
import { ToolRuntime } from '../src/tool-runtime.js';

test('drain closes admission and waits for the actual handler to settle after caller timeout', async () => {
  let finish;
  const registry = new CapabilityRegistry();
  registry.register({ schemaVersion: '0.1.0', id: 'tool/slow', kind: 'tool', name: 'Slow tool', version: '1.0.0', status: 'stable', description: 'test', provenance: { sourceType: 'test' } }, () => new Promise((resolve) => { finish = resolve; }));
  const gate = new RuntimeShutdownAdmission();
  const runtime = new ToolRuntime({ registry, shutdownAdmission: gate });
  const timedOut = await runtime.execute('tool/slow', {}, { executionId: 'one', timeoutMs: 10 });
  assert.equal(timedOut.status, 'timed_out');
  assert.deepEqual(gate.activeExecutions(), ['one']);
  gate.beginDrain({ deadlineMs: 1000 });
  assert.equal((await runtime.execute('tool/slow', {}, { executionId: 'two' })).error.code, 'ADMISSION_CLOSED');
  const drained = gate.waitForDrain();
  finish('late');
  assert.equal((await drained).state, 'stopped');
  assert.equal(gate.snapshot().activeCount, 0);
});

test('deadline reports active work, forced stop retains leases and cannot reopen early', async () => {
  const gate = new RuntimeShutdownAdmission();
  const lease = gate.admit('one');
  gate.beginDrain({ deadlineMs: 0 });
  await assert.rejects(gate.waitForDrain(), (error) => error.code === 'DRAIN_DEADLINE_EXCEEDED' && error.remainingExecutions[0] === 'one');
  assert.equal(gate.state(), 'draining');
  assert.equal(gate.forceStop().activeCount, 1);
  assert.throws(() => gate.reopen(), { code: 'ACTIVE_EXECUTIONS_PRESENT' });
  assert.equal(gate.release({ ...lease, token: 'stale' }), false);
  assert.equal(gate.release(lease), true);
  assert.equal(gate.reopen().state, 'accepting');
});

test('cancelled wait leaves drain closed; duplicate IDs and invalid deadlines fail', async () => {
  const gate = new RuntimeShutdownAdmission();
  const lease = gate.admit('one');
  assert.throws(() => gate.admit('one'), { code: 'EXECUTION_ALREADY_ADMITTED' });
  assert.throws(() => gate.beginDrain({ deadlineMs: -1 }), { code: 'DEADLINE_INVALID' });
  gate.beginDrain({ deadlineMs: 500 });
  const controller = new AbortController();
  const wait = gate.waitForDrain({ signal: controller.signal });
  controller.abort();
  await assert.rejects(wait, { code: 'DRAIN_CANCELLED' });
  assert.throws(() => gate.admit('two'), { code: 'ADMISSION_CLOSED' });
  gate.release(lease);
  assert.equal((await gate.waitForDrain()).state, 'stopped');
});
