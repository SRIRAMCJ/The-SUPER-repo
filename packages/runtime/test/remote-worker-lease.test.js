import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';

test('acquires and renews worker lease', () => {
  let now = 1000;
  const manager = new RemoteWorkerLeaseManager({ clock: () => now, ttlMs: 100 });
  const acquired = manager.acquire({ executionId: 'e1', workerId: 'w1' });
  assert.equal(acquired.state, 'acquired');
  now = 1050;
  const renewed = manager.renew(acquired.lease.leaseId);
  assert.equal(renewed.lease.expiresAt, 1150);
});

test('expires leases deterministically', () => {
  let now = 0;
  const manager = new RemoteWorkerLeaseManager({ clock: () => now, ttlMs: 10 });
  const acquired = manager.acquire({ executionId: 'e1', workerId: 'w1' });
  now = 11;
  assert.equal(manager.expire().expired, 1);
  assert.equal(manager.get(acquired.lease.leaseId).status, 'expired');
});

test('prevents duplicate active lease for an execution', () => {
  const manager = new RemoteWorkerLeaseManager({ ttlMs: 100 });
  manager.acquire({ executionId: 'e1', workerId: 'w1' });
  const conflict = manager.acquire({ executionId: 'e1', workerId: 'w2' });
  assert.equal(conflict.code, 'LEASE_ALREADY_HELD');
});

test('release is terminal and idempotent', () => {
  const manager = new RemoteWorkerLeaseManager();
  const acquired = manager.acquire({ executionId: 'e1', workerId: 'w1' });
  assert.equal(manager.release(acquired.lease.leaseId).state, 'released');
  assert.equal(manager.release(acquired.lease.leaseId).state, 'already_terminal');
});

test('snapshots are isolated', () => {
  const manager = new RemoteWorkerLeaseManager();
  const acquired = manager.acquire({ executionId: 'e1', workerId: 'w1' });
  const copy = manager.get(acquired.lease.leaseId);
  copy.status = 'bad';
  assert.equal(manager.get(acquired.lease.leaseId).status, 'active');
});

test('rejects stale fencing tokens', () => {
  const manager = new RemoteWorkerLeaseManager();
  const acquired = manager.acquire({ executionId: 'e1', workerId: 'w1' });
  const validation = manager.validate(acquired.lease.leaseId, 'stale', 'w1');
  assert.equal(validation.code, 'STALE_FENCING_TOKEN');
});
