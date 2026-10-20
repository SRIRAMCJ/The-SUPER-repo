import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RuntimeLifecycleManager } from '../src/lifecycle.js';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';
import { RuntimeShutdownCoordinator } from '../src/shutdown-coordinator.js';
import { installProcessShutdown } from '../src/process-shutdown.js';

function setup() {
  const calls = [];
  const processRef = Object.assign(new EventEmitter(), { exit: (code) => calls.push(['exit', code]) });
  const lifecycle = new RuntimeLifecycleManager({ components: [{ name: 'service', stop: () => calls.push('stop') }] });
  const admission = new RuntimeShutdownAdmission();
  const coordinator = new RuntimeShutdownCoordinator({ lifecycle, admission });
  return { calls, processRef, lifecycle, admission, coordinator };
}

test('SIGTERM closes admission immediately and stops only after active work releases', async () => {
  const { calls, processRef, lifecycle, admission, coordinator } = setup();
  await coordinator.start();
  const lease = admission.admit('active');
  const wiring = installProcessShutdown({ coordinator, processRef, deadlineMs: 1000 });
  processRef.emit('SIGTERM');
  assert.equal(admission.state(), 'draining');
  assert.throws(() => admission.admit('late'), { code: 'ADMISSION_CLOSED' });
  assert.deepEqual(calls, []);
  admission.release(lease);
  await wiring.pending;
  assert.equal(lifecycle.getState().state, 'stopped');
  assert.deepEqual(calls, ['stop']);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
  assert.equal(processRef.listenerCount('SIGINT'), 0);
});

test('deadline reports failure and exits with the signal code', async () => {
  const { calls, processRef, admission, coordinator } = setup();
  await coordinator.start();
  admission.admit('stuck');
  const errors = [];
  const wiring = installProcessShutdown({ coordinator, processRef, deadlineMs: 0, onError: (error, signal) => errors.push([error.code, signal]) });
  processRef.emit('SIGTERM');
  await assert.rejects(wiring.pending, { code: 'DRAIN_DEADLINE_EXCEEDED' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [['DRAIN_DEADLINE_EXCEEDED', 'SIGTERM']]);
  assert.deepEqual(calls, [['exit', 143]]);
  assert.equal(admission.snapshot().activeCount, 1);
});

test('a second signal forces termination and disposal is idempotent', async () => {
  const { calls, processRef, admission, coordinator } = setup();
  await coordinator.start();
  const lease = admission.admit('stuck');
  const wiring = installProcessShutdown({ coordinator, processRef, deadlineMs: 1000, onError: () => { throw new Error('should not run'); } });
  processRef.emit('SIGTERM');
  processRef.emit('SIGINT');
  assert.deepEqual(calls, [['exit', 130]]);
  assert.equal(admission.snapshot().activeCount, 1);
  admission.release(lease);
  await wiring.pending;
  wiring.dispose(); wiring.dispose();
  assert.deepEqual(calls, [['exit', 130], 'stop']);
});

test('invalid process dependencies fail before installing handlers', () => {
  const { coordinator, processRef } = setup();
  assert.throws(() => installProcessShutdown({ coordinator, processRef, deadlineMs: -1 }), /deadlineMs/);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
});
