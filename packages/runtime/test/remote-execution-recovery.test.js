import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteExecutionRecovery } from '../src/remote-execution-recovery.js';

test('recovery reassigns a retryable failed execution to another worker', async () => {
  const schedules = [
    { state: 'scheduled', workerId: 'worker-a', leaseId: 'lease-a', fencingToken: 'fence-a' },
    { state: 'scheduled', workerId: 'worker-b', leaseId: 'lease-b', fencingToken: 'fence-b' },
  ];
  const calls = [];
  const scheduler = {
    schedule: () => schedules.shift(),
    reassign(input) { calls.push(input); return schedules.shift(); },
  };
  const transport = {
    async execute(_request, context) {
      if (calls.length === 0) {
        assert.equal(context.workerId, 'worker-a');
        throw Object.assign(new Error('worker lost'), { code: 'WORKER_UNAVAILABLE', retryable: true });
      }
      assert.equal(context.workerId, 'worker-b');
      return { status: 'succeeded', output: { ok: true } };
    },
  };
  const recovery = new RemoteExecutionRecovery({ scheduler, transport, maxAttempts: 2 });
  const result = await recovery.execute({ executionId: 'e-recover', capabilityId: 'runtime.execute' });
  assert.equal(result.state, 'completed');
  assert.equal(result.attempt, 2);
  assert.equal(calls[0].failedWorkerId, 'worker-a');
});

test('recovery stops immediately on non-retryable failure', async () => {
  let calls = 0;
  const recovery = new RemoteExecutionRecovery({
    scheduler: { schedule: () => ({ state: 'scheduled', workerId: 'worker-a', leaseId: 'lease-a', fencingToken: 'fence-a' }), reassign: () => { throw new Error('should not run'); } },
    transport: { async execute() { calls += 1; throw Object.assign(new Error('invalid command'), { code: 'INVALID_COMMAND', retryable: false }); } },
    maxAttempts: 3,
  });
  const result = await recovery.execute({ executionId: 'e-no-retry', capabilityId: 'runtime.execute' });
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'INVALID_COMMAND');
  assert.equal(calls, 1);
});
