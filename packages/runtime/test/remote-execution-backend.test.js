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

import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';
import { RemoteWorkerScheduler } from '../src/remote-worker-scheduler.js';
import { RemoteWorkerFailoverController } from '../src/remote-worker-failover.js';
import { RemoteWorkerHeartbeatMonitor } from '../src/remote-worker-heartbeat.js';
import { InMemoryRemoteExecutionTransport } from '../src/remote-execution-transport.js';

test('heartbeat failure reassigns an active execution and recovery resumes it on a live worker', async () => {
  let now = Date.parse('2026-09-20T00:00:00Z');
  const registry = new RemoteWorkerRegistry({ clock: () => new Date(now) });
  registry.register({ workerId: 'worker-a', capabilities: ['runtime.execute'] });
  registry.register({ workerId: 'worker-b', capabilities: ['runtime.execute'] });
  const leases = new RemoteWorkerLeaseManager({ clock: () => now, ttlMs: 60_000 });
  const scheduler = new RemoteWorkerScheduler({ registry, leases, clock: () => now });
  const failover = new RemoteWorkerFailoverController({ scheduler });
  let releaseFirst;
  const firstFinished = new Promise(resolve => { releaseFirst = resolve; });
  const transport = new InMemoryRemoteExecutionTransport({ workerRegistry: registry, leaseManager: leases });
  transport.registerWorker({ workerId: 'worker-a', capabilities: ['runtime.execute'], execute: async () => { await firstFinished; return { status: 'succeeded', output: { worker: 'worker-a' } }; } });
  transport.registerWorker({ workerId: 'worker-b', capabilities: ['runtime.execute'], execute: async () => ({ status: 'succeeded', output: { worker: 'worker-b' } }) });
  const backend = new RemoteExecutionBackend({ transport, scheduler, maxRecoveryAttempts: 2 });
  const monitor = new RemoteWorkerHeartbeatMonitor({ registry, leaseManager: leases, failoverController: failover, clock: () => now, timeoutMs: 30_000 });

  const pending = backend.execute({ executionId: 'exec-heartbeat-recovery', input: { command: 'node', args: [] }, capability: { id: 'runtime.execute' } });
  assert.equal(scheduler.current('exec-heartbeat-recovery').workerId, 'worker-a');
  now += 31_000;
  const sweep = await monitor.sweep();
  assert.equal(sweep.lost.length, 1);
  assert.equal(sweep.lost[0].reassignment.state, 'scheduled');
  assert.equal(sweep.lost[0].reassignment.workerId, 'worker-b');
  releaseFirst();
  const result = await pending;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.workerId, 'worker-b');
  assert.equal(result.attempt, 2);
  const executionLeases = leases.list().filter(lease => lease.executionId === 'exec-heartbeat-recovery');
  assert.equal(executionLeases.length, 2);
  assert.equal(executionLeases[0].status, 'fenced');
  assert.equal(executionLeases[1].status, 'released');
});

test('remote backend schedules through the worker scheduler and dispatches the issued lease', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const scheduler = new RemoteWorkerScheduler({ registry, leases });
  const transport = new InMemoryRemoteExecutionTransport({ workerRegistry: registry, leaseManager: leases });
  const seen = [];
  transport.registerWorker({
    workerId: 'worker-scheduler',
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
  assert.equal(result.workerId, 'worker-scheduler');
  assert.ok(result.leaseId);
  assert.ok(result.fencingToken);
  assert.equal(seen[0].workerId, 'worker-scheduler');
  assert.equal(seen[0].leaseId, result.leaseId);
  assert.equal(seen[0].fencingToken, result.fencingToken);
  assert.equal(leases.get(result.leaseId).status, 'released');
});

test('remote backend does not dispatch when scheduler has no capable worker', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const scheduler = new RemoteWorkerScheduler({ registry, leases });
  let dispatched = false;
  const backend = new RemoteExecutionBackend({ scheduler, transport: { execute: async () => { dispatched = true; } } });
  const result = await backend.execute({
    executionId: 'exec-no-capable-worker',
    capability: { id: 'runtime.execute' },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'NO_CAPABLE_WORKER');
  assert.equal(result.error.retryable, true);
  assert.equal(dispatched, false);
});
