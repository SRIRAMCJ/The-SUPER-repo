import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRemoteExecutionStore } from '../src/remote-execution-store.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';
import { RemoteWorkerIdentityRegistry } from '../src/remote-worker-identity.js';
import { RemoteRecoveryCoordinator } from '../src/remote-recovery-coordinator.js';
import { RemoteWorkerFailoverController } from '../src/remote-worker-failover.js';

test('remote leases survive manager restart and preserve fencing monotonicity', () => {
  const store = new InMemoryRemoteExecutionStore();
  const first = new RemoteWorkerLeaseManager({ store });
  const acquired = first.acquire({ executionId: 'e1', workerId: 'w1', capabilityId: 'runtime.execute' });
  first.fence(acquired.lease.leaseId, 'test');

  const second = new RemoteWorkerLeaseManager({ store });
  const restored = second.get(acquired.lease.leaseId);
  assert.equal(restored.status, 'fenced');

  const next = second.acquire({ executionId: 'e2', workerId: 'w1', capabilityId: 'runtime.execute' });
  assert.notEqual(next.lease.leaseId, acquired.lease.leaseId);
  assert.notEqual(next.lease.fencingToken, acquired.lease.fencingToken);
});

test('worker identity rejects stale incarnations and out-of-order heartbeats', () => {
  const identities = new RemoteWorkerIdentityRegistry();
  const first = identities.register('worker-a');
  assert.equal(identities.heartbeat('worker-a', first.workerInstanceId, 1).state, 'accepted');
  assert.equal(identities.heartbeat('worker-a', first.workerInstanceId, 1).code, 'STALE_HEARTBEAT_SEQUENCE');

  const second = identities.register('worker-a');
  assert.notEqual(second.workerInstanceId, first.workerInstanceId);
  assert.equal(identities.heartbeat('worker-a', first.workerInstanceId, 2).code, 'STALE_WORKER_INSTANCE');
  assert.equal(identities.heartbeat('worker-a', second.workerInstanceId, 1).state, 'accepted');
});

test('recovery coordinator makes concurrent failover single-flight', async () => {
  const coordinator = new RemoteRecoveryCoordinator();
  let calls = 0;
  const operation = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { state: 'scheduled', workerId: 'worker-b' };
  };
  const [a, b] = await Promise.all([
    coordinator.run('exec-1', operation),
    coordinator.run('exec-1', operation),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(coordinator.size(), 0);
});

test('failover controller coalesces duplicate recovery requests', async () => {
  let reassignments = 0;
  const scheduler = {
    current: () => ({ workerId: 'worker-a', leaseId: 'l1', fencingToken: 'f1' }),
    reassign: async () => {
      reassignments += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return { state: 'scheduled', workerId: 'worker-b', leaseId: 'l2', fencingToken: 'f2' };
    },
  };
  const controller = new RemoteWorkerFailoverController({ scheduler });
  const [a, b] = await Promise.all([
    controller.handleExecutionLost({ executionId: 'exec-2', workerId: 'worker-a', capabilityId: 'runtime.execute' }),
    controller.handleExecutionLost({ executionId: 'exec-2', workerId: 'worker-a', capabilityId: 'runtime.execute' }),
  ]);
  assert.equal(reassignments, 1);
  assert.deepEqual(a, b);
});
