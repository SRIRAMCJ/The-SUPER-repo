import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeLifecycleManager, RUNTIME_LIFECYCLE_STATES } from '../src/index.js';

const clock = () => new Date('2026-09-17T10:00:00.000Z');

test('lifecycle manager starts dependencies in order and stops them in reverse order', async () => {
  const calls = [];
  const manager = new RuntimeLifecycleManager({
    clock,
    components: [
      { name: 'api', dependsOn: ['runtime'], start: () => calls.push('api:start'), stop: () => calls.push('api:stop') },
      { name: 'runtime', start: () => calls.push('runtime:start'), stop: () => calls.push('runtime:stop') }
    ]
  });
  await manager.start();
  assert.deepEqual(calls, ['runtime:start', 'api:start']);
  assert.equal(manager.getState().state, 'running');
  await manager.drain();
  assert.equal(manager.getState().state, 'draining');
  await manager.stop();
  assert.deepEqual(calls, ['runtime:start', 'api:start', 'api:stop', 'runtime:stop']);
  assert.equal(manager.getState().state, 'stopped');
});

test('lifecycle transitions are explicit and invalid transitions are rejected', async () => {
  const manager = new RuntimeLifecycleManager({ clock });
  assert.deepEqual(RUNTIME_LIFECYCLE_STATES, ['bootstrap', 'initializing', 'ready', 'running', 'draining', 'stopping', 'stopped', 'failed']);
  await assert.rejects(() => manager.transition('running'), /Invalid lifecycle transition/);
  await manager.start();
  await assert.rejects(() => manager.start(), /Cannot start while runtime is running/);
  await manager.stop();
});

test('startup failure enters failed state and retains a diagnostic history entry', async () => {
  const manager = new RuntimeLifecycleManager({
    clock,
    components: [
      { name: 'database', start: () => { throw new Error('database unavailable'); }, stop: () => {} }
    ]
  });
  await assert.rejects(() => manager.start(), /database unavailable/);
  assert.equal(manager.getState().state, 'failed');
  const history = manager.getHistory();
  assert.ok(history.some((entry) => entry.state === 'failed' && entry.error === 'database unavailable'));
});

test('partial startup rolls back in reverse order and can restart after cleanup', async () => {
  const calls = [];
  let broken = true;
  const manager = new RuntimeLifecycleManager({ components: [
    { name: 'storage', start: () => calls.push('storage:start'), stop: () => calls.push('storage:stop') },
    { name: 'worker', dependsOn: ['storage'], start: () => calls.push('worker:start'), stop: () => calls.push('worker:stop') },
    { name: 'api', dependsOn: ['worker'], start: () => { calls.push('api:start'); if (broken) throw new Error('api unavailable'); }, stop: () => calls.push('api:stop') }
  ] });
  await assert.rejects(manager.start(), /api unavailable/);
  assert.deepEqual(calls, ['storage:start', 'worker:start', 'api:start', 'worker:stop', 'storage:stop']);
  assert.equal(manager.getState().cleanupRequired, false);
  broken = false;
  await manager.start();
  assert.equal(manager.getState().state, 'running');
  await manager.stop();
});

test('rollback and stop failures continue cleanup and block restart until a successful stop', async () => {
  const calls = [];
  let stopFails = true;
  let startupFails = true;
  const manager = new RuntimeLifecycleManager({ components: [
    { name: 'a', start: () => calls.push('a:start'), stop: () => calls.push('a:stop') },
    { name: 'b', dependsOn: ['a'], start: () => calls.push('b:start'), stop: () => { calls.push('b:stop'); if (stopFails) throw new Error('b stuck'); } },
    { name: 'c', dependsOn: ['b'], start: () => { calls.push('c:start'); if (startupFails) throw new Error('c offline'); }, stop: () => calls.push('c:stop') }
  ] });
  await assert.rejects(manager.start(), (error) => error instanceof AggregateError && error.errors.some((item) => item.message === 'c offline') && error.errors.some((item) => item.message === 'b stuck'));
  assert.deepEqual(calls.slice(-2), ['b:stop', 'a:stop']);
  assert.equal(manager.getState().cleanupRequired, true);
  await assert.rejects(manager.start(), /cleanup succeeds/);
  await assert.rejects(manager.stop(), AggregateError);
  assert.deepEqual(calls.slice(-3), ['c:stop', 'b:stop', 'a:stop']);
  stopFails = false;
  await manager.stop();
  assert.equal(manager.getState().cleanupRequired, false);
  startupFails = false;
  await manager.start();
  await manager.stop();
});

test('dependency cycles and missing dependencies fail deterministically', async () => {
  const cycle = new RuntimeLifecycleManager({ components: [
    { name: 'a', dependsOn: ['b'], start: () => {} },
    { name: 'b', dependsOn: ['a'], start: () => {} }
  ] });
  await assert.rejects(() => cycle.start(), /dependency cycle/);

  const missing = new RuntimeLifecycleManager({ components: [
    { name: 'a', dependsOn: ['missing'], start: () => {} }
  ] });
  await assert.rejects(() => missing.start(), /Unknown lifecycle dependency/);
});

test('lifecycle state and history are isolated from caller mutation', async () => {
  const manager = new RuntimeLifecycleManager({ clock });
  await manager.start();
  const state = manager.getState();
  assert.throws(() => { state.activeOperation = { component: 'evil' }; }, TypeError);
  const history = manager.getHistory();
  assert.throws(() => history.push({ state: 'evil' }), TypeError);
  assert.equal(manager.getState().activeOperation, null);
  assert.equal(manager.getHistory().some((entry) => entry.state === 'evil'), false);
  await manager.stop();
});
