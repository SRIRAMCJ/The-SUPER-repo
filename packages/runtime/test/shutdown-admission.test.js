import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeShutdownAdmission } from '../src/shutdown-admission.js';

test('admits executions and blocks new work once draining begins', () => {
  let now = 1_000;
  const runtime = new RuntimeShutdownAdmission({ clock: () => now, idFactory: (prefix) => `${prefix}-${now}` });
  const admission = runtime.admit({ executionId: 'e1', metadata: { lane: 'interactive' } });
  assert.equal(admission.executionId, 'e1');
  runtime.beginDrain({ deadlineMs: 100 });
  assert.throws(() => runtime.admit({ executionId: 'e2' }), { code: 'ADMISSION_CLOSED' });
  assert.equal(runtime.isAdmitted('e1'), true);
});

test('waits for active work and transitions to stopped after release', async () => {
  const runtime = new RuntimeShutdownAdmission({ clock: () => Date.now(), idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })() });
  runtime.admit({ executionId: 'e1' });
  runtime.beginDrain({ deadlineMs: 500 });
  const waiting = runtime.waitForDrain({ deadlineMs: 500, pollMs: 1 });
  runtime.release('e1');
  const snapshot = await waiting;
  assert.equal(snapshot.state, 'stopped');
  assert.equal(snapshot.activeCount, 0);
});

test('reports the exact remaining executions when the deadline expires', async () => {
  let now = 0;
  const runtime = new RuntimeShutdownAdmission({ clock: () => now, idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })() });
  runtime.admit({ executionId: 'e1' });
  runtime.beginDrain({ deadlineMs: 10 });
  const waiting = runtime.waitForDrain({ deadlineMs: 10, pollMs: 0 });
  now = 11;
  await assert.rejects(waiting, (error) => error.code === 'DRAIN_DEADLINE_EXCEEDED' && error.remainingExecutions[0] === 'e1');
});

test('keeps bounded immutable history and supports forced stop', () => {
  const runtime = new RuntimeShutdownAdmission({ historyLimit: 2, idFactory: (() => { let n = 0; return (prefix) => `${prefix}-${++n}`; })() });
  runtime.admit({ executionId: 'e1' });
  runtime.beginDrain({ deadlineMs: 10 });
  runtime.forceStop();
  const history = runtime.history();
  assert.equal(history.length, 2);
  assert.equal(Object.isFrozen(history), true);
  assert.equal(Object.isFrozen(history[0]), true);
  assert.equal(runtime.state(), 'stopped');
});

test('rejects cancellation during drain without reopening admission', async () => {
  const runtime = new RuntimeShutdownAdmission({ clock: () => Date.now() });
  runtime.admit({ executionId: 'e1' });
  runtime.beginDrain({ deadlineMs: 500 });
  const controller = new AbortController();
  const waiting = runtime.waitForDrain({ deadlineMs: 500, pollMs: 50, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { code: 'DRAIN_CANCELLED' });
  assert.equal(runtime.state(), 'draining');
  assert.throws(() => runtime.admit({ executionId: 'e2' }), { code: 'ADMISSION_CLOSED' });
});