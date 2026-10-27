import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileFailoverStore, RemoteWorkerCoordinator } from '../src/index.js';

test('coordinator commits a fenced result and replays without redispatch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-remote-coordinator-'));
  try {
    const leaseStore = new FileFailoverStore(path.join(directory, 'leases.json'));
    let calls = 0;
    const client = { execute: async ({ fence }) => { calls++; assert.equal(fence.key, 'execution-1'); return { answer: 42 }; } };
    const coordinator = new RemoteWorkerCoordinator({ nodeId: 'node-1', client, leaseStore });
    const request = { executionId: 'execution-1', requestId: 'request-1', capabilityId: 'compute', input: { n: 21 } };
    assert.deepEqual(await coordinator.execute(request), { answer: 42 });
    assert.deepEqual(await new RemoteWorkerCoordinator({ nodeId: 'node-1', client, leaseStore }).execute(request), { answer: 42 });
    assert.equal(calls, 1);
    await assert.rejects(coordinator.execute({ ...request, input: { n: 22 } }), { code: 'REMOTE_EXECUTION_CONFLICT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('coordinator does not release an uncertain remote effect lease', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-remote-uncertain-'));
  try {
    const leaseStore = new FileFailoverStore(path.join(directory, 'leases.json'));
    const coordinator = new RemoteWorkerCoordinator({ nodeId: 'node-1', leaseStore,
      client: { execute: async () => { throw Object.assign(new Error('connection lost'), { code: 'REMOTE_CONNECTION_CLOSED' }); } } });
    await assert.rejects(coordinator.execute({ executionId: 'execution-1', requestId: 'request-1', capabilityId: 'compute' }), { code: 'REMOTE_CONNECTION_CLOSED' });
    assert.equal((await leaseStore.inspect('execution-1')).owner, 'node-1');
    await assert.rejects(coordinator.execute({ executionId: 'execution-1', requestId: 'request-1', capabilityId: 'compute' }), { code: 'FAILOVER_LEASE_HELD' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
