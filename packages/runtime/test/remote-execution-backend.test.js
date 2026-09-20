import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteExecutionBackend } from '../src/remote-execution-backend.js';

test('remote backend submits a normalized provider-neutral execution request', async () => {
  const calls = [];
  const backend = new RemoteExecutionBackend({ transport: { async execute(request, context) { calls.push({ request, context }); return { status: 'succeeded', output: { value: 42 }, remoteExecutionId: 'remote-42' }; } } });
  const controller = new AbortController();
  const result = await backend.execute({ executionId: 'exec-remote-1', input: { command: 'node', args: ['-e', 'process.stdout.write("ok")'] }, context: { signal: controller.signal, timeoutMs: 2500 }, capability: { id: 'runtime/remote-test', execution: { backend: 'remote' } } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.backend, 'remote');
  assert.equal(result.remoteExecutionId, 'remote-42');
  assert.deepEqual(result.output, { value: 42 });
  assert.equal(calls[0].request.command, 'node');
  assert.equal(calls[0].request.timeoutMs, 2500);
  assert.strictEqual(calls[0].context.signal, controller.signal);
});

test('remote backend propagates cancellation', async () => {
  const controller = new AbortController();
  const backend = new RemoteExecutionBackend({ transport: { async execute(_request, { signal }) { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } } });
  const pending = backend.execute({ executionId: 'exec-cancel', context: { signal: controller.signal } });
  controller.abort(new Error('user cancelled'));
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.code, 'CANCELLED');
});

test('remote backend rejects malformed transport results', async () => {
  const backend = new RemoteExecutionBackend({ transport: { execute: async () => ({ status: 'wat' }) } });
  const result = await backend.execute({ executionId: 'exec-invalid' });
  assert.equal(result.error.code, 'INVALID_REMOTE_STATUS');
});

test('remote backend preserves retryable transport failures', async () => {
  const backend = new RemoteExecutionBackend({ transport: { async execute() { throw Object.assign(new Error('worker unavailable'), { code: 'REMOTE_UNAVAILABLE', retryable: true }); } } });
  const result = await backend.execute({ executionId: 'exec-failure' });
  assert.deepEqual(result.error, { code: 'REMOTE_UNAVAILABLE', message: 'worker unavailable', retryable: true });
});

test('remote backend validates command and arguments before dispatch', async () => {
  let calls = 0;
  const backend = new RemoteExecutionBackend({ transport: { execute: async () => { calls += 1; } } });
  const invalidCommand = await backend.execute({ executionId: 'exec-command', input: { command: 42 } });
  const invalidArgs = await backend.execute({ executionId: 'exec-args', input: { command: 'node', args: [1] } });
  assert.equal(invalidCommand.error.code, 'INVALID_COMMAND');
  assert.equal(invalidArgs.error.code, 'INVALID_ARGUMENTS');
  assert.equal(calls, 0);
});


import { InMemoryRemoteExecutionTransport } from '../src/remote-execution-transport.js';
import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';
import { RemoteWorkerScheduler } from '../src/remote-worker-scheduler.js';

test('remote backend admits execution through scheduler and propagates ownership into transport', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const scheduler = new RemoteWorkerScheduler({ registry, leases });
  const seen = [];
  const transport = new InMemoryRemoteExecutionTransport({ workerRegistry: registry, leaseManager: leases });
  transport.registerWorker({
    workerId: 'worker-a',
    capabilities: ['runtime.execute'],
    execute: async (_request, context) => {
      seen.push(context);
      return { status: 'succeeded', output: { workerId: context.workerId } };
    },
  });

  const backend = new RemoteExecutionBackend({ transport, scheduler });
  const result = await backend.execute({
    executionId: 'exec-scheduler-dispatch',
    input: { command: 'node', args: [] },
    capability: { id: 'runtime.execute' },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.workerId, 'worker-a');
  assert.ok(result.leaseId);
  assert.ok(result.fencingToken);
  assert.equal(seen[0].workerId, 'worker-a');
  assert.equal(seen[0].leaseId, result.leaseId);
  assert.equal(seen[0].fencingToken, result.fencingToken);
  assert.equal(leases.get(result.leaseId).status, 'released');
});

test('remote backend fails closed before transport dispatch when no capable worker exists', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const scheduler = new RemoteWorkerScheduler({ registry, leases });
  let dispatched = false;
  const backend = new RemoteExecutionBackend({
    scheduler,
    transport: { execute: async () => { dispatched = true; return { status: 'succeeded' }; } },
  });

  const result = await backend.execute({
    executionId: 'exec-no-capable-worker',
    capability: { id: 'runtime.execute' },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'NO_CAPABLE_WORKER');
  assert.equal(result.error.retryable, true);
  assert.equal(dispatched, false);
});

test('remote backend recovers retryable worker failure by reassigning to another worker', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const scheduler = new RemoteWorkerScheduler({ registry, leases });
  const transport = new InMemoryRemoteExecutionTransport({ workerRegistry: registry, leaseManager: leases });
  const attempts = [];

  transport.registerWorker({
    workerId: 'worker-a',
    capabilities: ['runtime.execute'],
    execute: async () => {
      attempts.push('worker-a');
      throw Object.assign(new Error('worker unavailable'), { code: 'WORKER_UNAVAILABLE', retryable: true });
    },
  });
  transport.registerWorker({
    workerId: 'worker-b',
    capabilities: ['runtime.execute'],
    execute: async () => {
      attempts.push('worker-b');
      return { status: 'succeeded', output: { recovered: true } };
    },
  });

  const backend = new RemoteExecutionBackend({ transport, scheduler, maxRecoveryAttempts: 2 });
  const result = await backend.execute({
    executionId: 'exec-recovery',
    input: { command: 'node', args: [] },
    capability: { id: 'runtime.execute' },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.attempt, 2);
  assert.deepEqual(attempts, ['worker-a', 'worker-b']);
});

test('remote backend requires capability identity when scheduler mode is enabled', async () => {
  const scheduler = { schedule: () => ({ state: 'scheduled', workerId: 'worker-a', leaseId: 'lease-a', fencingToken: 'fence-a' }), reassign: () => ({ state: 'scheduled', workerId: 'worker-a', leaseId: 'lease-a', fencingToken: 'fence-a' }) };
  const backend = new RemoteExecutionBackend({ scheduler, transport: { execute: async () => ({ status: 'succeeded' }) } });
  const result = await backend.execute({ executionId: 'exec-capability-required', input: { command: 'node', args: [] } });
  assert.equal(result.error.code, 'CAPABILITY_REQUIRED');
});
