import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteWorkerFailoverController } from '../src/remote-worker-failover.js';

test('failover reassigns a heartbeat-lost execution while preserving execution identity', async () => {
  const calls = [];
  const scheduler = {
    current: () => null,
    reassign(input) {
      calls.push(input);
      return { state: 'scheduled', workerId: 'worker-b', leaseId: 'lease-2', fencingToken: 'fence-2' };
    },
  };
  const controller = new RemoteWorkerFailoverController({ scheduler, capabilityResolver: async () => 'runtime.execute' });
  const result = await controller.handleExecutionLost({ executionId: 'e-heartbeat', workerId: 'worker-a' });
  assert.equal(result.state, 'scheduled');
  assert.equal(result.executionId, 'e-heartbeat');
  assert.equal(result.workerId, 'worker-b');
  assert.equal(calls[0].failedWorkerId, 'worker-a');
});

test('failover blocks when capability cannot be resolved', async () => {
  const controller = new RemoteWorkerFailoverController({
    scheduler: { reassign: () => { throw new Error('should not run'); } },
    capabilityResolver: async () => null,
  });
  const result = await controller.handleExecutionLost({ executionId: 'e-unknown', workerId: 'worker-a' });
  assert.equal(result.state, 'blocked');
  assert.equal(result.code, 'CAPABILITY_REQUIRED');
});
