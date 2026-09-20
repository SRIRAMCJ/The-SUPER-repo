import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRemoteExecutionTransport } from '../src/remote-execution-transport.js';

test('transport registers workers and tracks heartbeat health', () => {
  let now = 1000;
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => now, leaseTtlMs: 100 });
  transport.registerWorker({ workerId: 'worker-a', execute: async () => ({ status: 'succeeded' }) });
  assert.equal(transport.listWorkers()[0].healthy, true);
  now = 1201;
  assert.equal(transport.listWorkers()[0].healthy, false);
  transport.heartbeat('worker-a');
  assert.equal(transport.listWorkers()[0].healthy, true);
});

test('transport creates a lease and correlates the remote execution id', async () => {
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => 1000 });
  transport.registerWorker({ workerId: 'worker-a', execute: async request => ({ status: 'succeeded', output: { executionId: request.executionId } }) });
  const result = await transport.execute({ executionId: 'exec-1', command: 'node', args: [] });
  assert.equal(result.status, 'succeeded');
  assert.ok(result.remoteExecutionId);
  assert.equal(transport.inspect(result.remoteExecutionId).executionId, 'exec-1');
  assert.equal(transport.inspect(result.remoteExecutionId).status, 'succeeded');
});

test('transport fails closed when no healthy worker exists', async () => {
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => 5000, leaseTtlMs: 10 });
  await assert.rejects(() => transport.execute({ executionId: 'exec-no-worker' }), error => error.code === 'NO_HEALTHY_WORKER' && error.retryable === true);
});

test('transport cancellation updates the execution lease', async () => {
  let release;
  const controller = new AbortController();
  const transport = new InMemoryRemoteExecutionTransport({ clock: () => 1000 });
  transport.registerWorker({
    workerId: 'worker-a',
    execute: async (_request, { signal }) => new Promise((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(new Error('cancelled by caller')), { once: true });
    }),
  });
  const pending = transport.execute({ executionId: 'exec-cancel' }, { signal: controller.signal });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(transport.inspect(result.remoteExecutionId).status, 'cancelled');
  release({ status: 'succeeded' });
});

test('transport rejects duplicate worker registration', () => {
  const transport = new InMemoryRemoteExecutionTransport();
  const execute = async () => ({ status: 'succeeded' });
  transport.registerWorker({ workerId: 'worker-a', execute });
  assert.throws(() => transport.registerWorker({ workerId: 'worker-a', execute }), error => error.code === 'WORKER_ALREADY_REGISTERED');
});
