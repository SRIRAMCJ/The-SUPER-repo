import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';

test('registry registers workers with normalized capabilities', () => {
  const registry = new RemoteWorkerRegistry({ clock: () => new Date('2026-09-20T00:00:00.000Z') });
  const result = registry.register({ workerId: 'worker-b', capabilities: ['runtime.execute', 'runtime.execute'], metadata: { region: 'local' } });
  assert.equal(result.state, 'registered');
  assert.deepEqual(result.worker.capabilities, ['runtime.execute']);
  assert.equal(registry.get('worker-b').metadata.region, 'local');
});

test('registry resolves a healthy worker by capability deterministically', () => {
  const registry = new RemoteWorkerRegistry();
  registry.register({ workerId: 'worker-z', capabilities: ['runtime.execute'] });
  registry.register({ workerId: 'worker-a', capabilities: ['runtime.execute'] });
  assert.equal(registry.resolveCapability('runtime.execute').workerId, 'worker-a');
});

test('registry does not resolve unhealthy workers', () => {
  const registry = new RemoteWorkerRegistry();
  registry.register({ workerId: 'worker-a', capabilities: ['runtime.execute'] });
  registry.markUnhealthy('worker-a', 'heartbeat timeout');
  assert.equal(registry.resolveCapability('runtime.execute'), null);
});

test('registry heartbeat can refresh capability advertisement', () => {
  const registry = new RemoteWorkerRegistry();
  registry.register({ workerId: 'worker-a', capabilities: ['runtime.execute'] });
  const result = registry.heartbeat('worker-a', { capabilities: ['runtime.execute', 'artifact.store'] });
  assert.deepEqual(result.worker.capabilities, ['artifact.store', 'runtime.execute']);
  assert.equal(registry.resolveCapability('artifact.store').workerId, 'worker-a');
});

test('registry rejects duplicate registration without mutating the existing worker', () => {
  const registry = new RemoteWorkerRegistry();
  registry.register({ workerId: 'worker-a', capabilities: ['runtime.execute'] });
  const result = registry.register({ workerId: 'worker-a', capabilities: ['other'] });
  assert.equal(result.state, 'conflict');
  assert.deepEqual(registry.get('worker-a').capabilities, ['runtime.execute']);
});

test('registry snapshots are immutable and isolated', () => {
  const registry = new RemoteWorkerRegistry();
  registry.register({ workerId: 'worker-a', capabilities: ['runtime.execute'], metadata: { tags: ['a'] } });
  const snapshot = registry.get('worker-a');
  assert.throws(() => { snapshot.metadata.tags.push('b'); }, TypeError);
  assert.deepEqual(registry.get('worker-a').metadata.tags, ['a']);
});
