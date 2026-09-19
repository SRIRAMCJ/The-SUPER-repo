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

import { RemoteWorkerRegistry } from '../src/remote-worker-registry.js';
import { RemoteWorkerLeaseManager } from '../src/remote-worker-lease.js';

test('transport uses scheduler-issued lease and fencing token to dispatch to the selected worker', async () => {
  const registry=new RemoteWorkerRegistry(); const leases=new RemoteWorkerLeaseManager();
  const transport=new InMemoryRemoteExecutionTransport({ workerRegistry:registry, leaseManager:leases });
  transport.registerWorker({ workerId:'worker-a', capabilities:['runtime.execute'], execute:async (_request,ctx)=>({status:'succeeded',output:{workerId:ctx.workerId,fence:ctx.fencingToken}}) });
  const acquired=leases.acquire({executionId:'exec-fenced',workerId:'worker-a'});
  const result=await transport.execute({executionId:'exec-fenced',capability:{id:'runtime.execute'}},{workerId:'worker-a',leaseId:acquired.lease.leaseId,fencingToken:acquired.lease.fencingToken});
  assert.equal(result.status,'succeeded'); assert.equal(result.workerId,'worker-a'); assert.equal(result.fencingToken,acquired.lease.fencingToken);
});

test('transport rejects stale fenced ownership before dispatch', async () => {
  const registry=new RemoteWorkerRegistry(); const leases=new RemoteWorkerLeaseManager();
  const transport=new InMemoryRemoteExecutionTransport({ workerRegistry:registry, leaseManager:leases }); let calls=0;
  transport.registerWorker({ workerId:'worker-a', capabilities:['runtime.execute'], execute:async()=>{calls++;return {status:'succeeded'};} });
  const first=leases.acquire({executionId:'exec-stale',workerId:'worker-a'}); leases.fence(first.lease.leaseId); const second=leases.acquire({executionId:'exec-stale',workerId:'worker-a'});
  await assert.rejects(()=>transport.execute({executionId:'exec-stale',capability:{id:'runtime.execute'}},{workerId:'worker-a',leaseId:first.lease.leaseId,fencingToken:first.lease.fencingToken}),e=>e.code==='LEASE_NOT_ACTIVE');
  await assert.rejects(()=>transport.execute({executionId:'exec-stale',capability:{id:'runtime.execute'}},{workerId:'worker-a',leaseId:second.lease.leaseId,fencingToken:first.lease.fencingToken}),e=>e.code==='LEASE_NOT_ACTIVE');
  assert.equal(calls,0); assert.ok(second.lease.fencingToken!==first.lease.fencingToken);
});


test('transport fences active execution ownership when a worker is unregistered',async()=>{const registry=new RemoteWorkerRegistry();const leases=new RemoteWorkerLeaseManager();const transport=new InMemoryRemoteExecutionTransport({workerRegistry:registry,leaseManager:leases});let release;const gate=new Promise(resolve=>{release=resolve;});transport.registerWorker({workerId:'worker-dead',capabilities:['runtime.execute'],execute:async()=>{await gate;return {status:'succeeded'};}});const pending=transport.execute({executionId:'exec-unregister',capability:{id:'runtime.execute'}});await new Promise(resolve=>setImmediate(resolve));const remote=transport.inspect('rex-1');assert.equal(remote.workerId,'worker-dead');transport.unregisterWorker('worker-dead');release();await assert.rejects(()=>pending,e=>e.code==='STALE_FENCING_TOKEN');assert.equal(leases.get(remote.leaseId).status,'fenced');});

test('transport fails closed when scheduler-selected worker lacks the requested capability', async () => {
  const registry = new RemoteWorkerRegistry();
  const leases = new RemoteWorkerLeaseManager();
  const transport = new InMemoryRemoteExecutionTransport({ workerRegistry: registry, leaseManager: leases });
  transport.registerWorker({ workerId: 'worker-other', capabilities: ['runtime.other'], execute: async () => ({ status: 'succeeded' }) });
  await assert.rejects(
    () => transport.execute({ executionId: 'exec-capability-mismatch', capability: { id: 'runtime.execute' } }, { workerId: 'worker-other' }),
    error => error.code === 'NO_HEALTHY_WORKER' && error.retryable === true,
  );
});
