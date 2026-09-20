import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';
import { RemoteWorkerHeartbeatMonitor } from '../src/remote-worker-heartbeat.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';

test('marks workers unhealthy after heartbeat timeout', async () => {
  let now = Date.parse('2026-09-20T00:00:00Z');
  const registry = new RemoteWorkerRegistry({ clock: () => new Date(now) });
  registry.register({ workerId: 'w1', capabilities: ['runtime.execute'] });
  now += 31_000;
  const monitor = new RemoteWorkerHeartbeatMonitor({ registry, clock: () => now, timeoutMs: 30_000 });
  const result = await monitor.sweep();
  assert.equal(result.changed.length, 1);
  assert.equal(registry.get('w1').state, 'unhealthy');
});

test('does not mark fresh workers unhealthy', async () => {
  let now = Date.parse('2026-09-20T00:00:00Z');
  const registry = new RemoteWorkerRegistry({ clock: () => new Date(now) });
  registry.register({ workerId: 'w1' });
  now += 10_000;
  const monitor = new RemoteWorkerHeartbeatMonitor({ registry, clock: () => now });
  assert.equal((await monitor.sweep()).changed.length, 0);
});

test('reports worker health counts', () => {
  const registry = new RemoteWorkerRegistry();
  registry.register({ workerId: 'a' });
  registry.register({ workerId: 'b' });
  registry.markUnhealthy('b');
  const monitor = new RemoteWorkerHeartbeatMonitor({ registry });
  assert.deepEqual(monitor.status(), { schemaVersion: '0.2.0', total: 2, healthy: 1, unhealthy: 1 });
});

test('heartbeat loss fences active worker executions and emits recovery signal', async () => {
  let now = Date.parse('2026-09-20T00:00:00Z');
  const registry = new RemoteWorkerRegistry({ clock: () => new Date(now) });
  registry.register({ workerId: 'w1', capabilities: ['runtime.execute'] });
  const leases = new RemoteWorkerLeaseManager({ clock: () => now, ttlMs: 60_000 });
  const acquired = leases.acquire({ executionId: 'exec-lost', workerId: 'w1' });
  const lost = [];
  now += 31_000;
  const monitor = new RemoteWorkerHeartbeatMonitor({
    registry,
    leaseManager: leases,
    clock: () => now,
    timeoutMs: 30_000,
    onExecutionLost: async (event) => lost.push(event),
  });

  const result = await monitor.sweep();
  assert.equal(result.lost.length, 1);
  assert.equal(result.lost[0].executionId, 'exec-lost');
  assert.equal(leases.get(acquired.lease.leaseId).status, 'fenced');
  assert.equal(lost[0].leaseId, acquired.lease.leaseId);
});
