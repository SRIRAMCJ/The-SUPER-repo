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
  const calls = [];
  const manager = new RuntimeLifecycleManager({
    clock,
    components: [
      { name: 'database', start: () => calls.push('database:start'), stop: () => calls.push('database:stop') },
      { name: 'api', dependsOn: ['database'], start: () => { calls.push('api:start'); throw new Error('api unavailable'); }, stop: () => calls.push('api:stop') }
    ]
  });
  await assert.rejects(() => manager.start(), /api unavailable/);
  assert.deepEqual(calls, ['database:start', 'api:start', 'database:stop']);
  assert.equal(manager.getState().state, 'failed');
  const history = manager.getHistory();
  assert.ok(history.some((entry) => entry.state === 'failed' && entry.error === 'api unavailable'));
});

test('failed startup does not stop components that never started', async () => {
  const calls = [];
  const manager = new RuntimeLifecycleManager({
    components: [
      { name: 'first', start: () => calls.push('first:start'), stop: () => calls.push('first:stop') },
      { name: 'second', dependsOn: ['first'], start: () => { calls.push('second:start'); throw new Error('boom'); }, stop: () => calls.push('second:stop') },
      { name: 'third', dependsOn: ['second'], start: () => calls.push('third:start'), stop: () => calls.push('third:stop') }
    ]
  });
  await assert.rejects(() => manager.start(), /boom/);
  assert.deepEqual(calls, ['first:start', 'second:start', 'first:stop']);
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
  assert.throws(() => { history.push({ state: 'evil' }); }, TypeError);
  assert.equal(manager.getState().activeOperation, null);
  assert.equal(manager.getHistory().some((entry) => entry.state === 'evil'), false);
  await manager.stop();
});

test('concurrent lifecycle commands are serialized', async () => {
  const calls = [];
  const manager = new RuntimeLifecycleManager({
    clock,
    components: [{ name: 'runtime', start: async () => { calls.push('start'); await new Promise((resolve) => setTimeout(resolve, 5)); }, stop: () => calls.push('stop') }]
  });
  await Promise.all([manager.start(), manager.start().catch((error) => error)]);
  assert.deepEqual(calls, ['start']);
  assert.equal(manager.getState().state, 'running');
  await manager.stop();
});
