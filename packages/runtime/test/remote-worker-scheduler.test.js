import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';
import { RemoteWorkerScheduler } from '../src/remote-worker-scheduler.js';

function setup() {
  const registry = new RemoteWorkerRegistry();
  registry.register({ workerId: 'a', capabilities: ['runtime.execute'] });
  registry.register({ workerId: 'b', capabilities: ['runtime.execute'] });
  const leases = new RemoteWorkerLeaseManager();
  return { registry, leases, scheduler: new RemoteWorkerScheduler({ registry, leases }) };
}

test('schedules execution onto a capable healthy worker', () => {
  const { scheduler } = setup();
  const result = scheduler.schedule({ executionId: 'e1', capabilityId: 'runtime.execute' });
  assert.equal(result.state, 'scheduled');
  assert.equal(result.workerId, 'a');
  assert.ok(result.leaseId);
  assert.ok(result.fencingToken);
});

test('fails closed when no capable worker exists', () => {
  const registry = new RemoteWorkerRegistry();
  const scheduler = new RemoteWorkerScheduler({ registry, leases: new RemoteWorkerLeaseManager() });
  const result = scheduler.schedule({ executionId: 'e1', capabilityId: 'runtime.execute' });
  assert.equal(result.state, 'unavailable');
  assert.equal(result.code, 'NO_CAPABLE_WORKER');
  assert.equal(result.retryable, true);
});

test('surfaces active lease conflict as a retryable scheduling conflict', () => {
  const { scheduler } = setup();
  assert.equal(scheduler.schedule({ executionId: 'e1', capabilityId: 'runtime.execute' }).state, 'scheduled');
  const result = scheduler.schedule({ executionId: 'e1', capabilityId: 'runtime.execute' });
  assert.equal(result.state, 'conflict');
  assert.equal(result.retryable, true);
});

test('reassign fences the previous lease and schedules a replacement worker', () => {
  const { scheduler, leases } = setup();
  const first = scheduler.schedule({ executionId: 'e-reassign', capabilityId: 'runtime.execute' });
  const replacement = scheduler.reassign({
    executionId: 'e-reassign',
    capabilityId: 'runtime.execute',
    failedWorkerId: first.workerId,
  });
  assert.equal(replacement.state, 'scheduled');
  assert.equal(replacement.workerId, 'b');
  assert.equal(leases.get(first.leaseId).status, 'fenced');
  assert.notEqual(replacement.fencingToken, first.fencingToken);
});
