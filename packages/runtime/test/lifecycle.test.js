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
  state.activeOperation = { component: 'evil' };
  const history = manager.getHistory();
  history.push({ state: 'evil' });
  assert.equal(manager.getState().activeOperation, null);
  assert.equal(manager.getHistory().some((entry) => entry.state === 'evil'), false);
  await manager.stop();
});
