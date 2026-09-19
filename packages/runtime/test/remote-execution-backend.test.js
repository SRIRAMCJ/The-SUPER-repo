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
import { InMemoryRemoteExecutionTransport } from '../src/remote-execution-transport.js';

test('remote backend integrates scheduler, transport lease ownership, and failover end to end', async()=>{const registry=new RemoteWorkerRegistry();const leases=new RemoteWorkerLeaseManager();const scheduler=new RemoteWorkerScheduler({registry,leases});const transport=new InMemoryRemoteExecutionTransport({workerRegistry:registry,leaseManager:leases});let firstCalls=0;transport.registerWorker({workerId:'worker-a',capabilities:['runtime.execute'],execute:async()=>{firstCalls++;throw Object.assign(new Error('worker lost'),{code:'WORKER_LOST',retryable:true});}});transport.registerWorker({workerId:'worker-b',capabilities:['runtime.execute'],execute:async(request,ctx)=>({status:'succeeded',output:{worker:ctx.workerId,executionId:request.executionId}})});const backend=new RemoteExecutionBackend({transport,scheduler,maxRecoveryAttempts:2});const result=await backend.execute({executionId:'exec-e2e-failover',input:{command:'node',args:[]},capability:{id:'runtime.execute'}});assert.equal(firstCalls,1);assert.equal(result.status,'succeeded');assert.equal(result.workerId,'worker-b');assert.equal(result.attempt,2);assert.equal(result.executionId,'exec-e2e-failover');const leasesForExecution=leases.list().filter(x=>x.executionId==='exec-e2e-failover');assert.equal(leasesForExecution.length,2);assert.equal(leasesForExecution[0].status,'fenced');assert.equal(leasesForExecution[1].status,'released');});
