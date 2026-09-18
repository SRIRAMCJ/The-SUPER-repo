import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RecoveryFailoverOrchestrator } from '../src/recovery-failover.js';
import { RecoveryHandoffKernel } from '../src/recovery-handoff.js';
import { RecoveryLeaseKernel } from '../src/recovery-lease.js';
import { RecoveryStateReplicator } from '../src/recovery-state-replication.js';
import { DistributedCapabilityGate } from '../src/distributed-capability.js';
import { RemoteExecutionTransport } from '../src/remote-transport.js';

async function fixture() {
  const dir = await mkdtemp(join(process.cwd(), 'recovery-failover-'));
  const now = new Date('2026-09-18T06:00:00Z');
  const recoveryLease = new RecoveryLeaseKernel({ clock: () => now, leaseTtlMs: 60_000, idFactory: (p) => p + '-x' });
  const stateReplicator = new RecoveryStateReplicator({ filePath: join(dir, 'state.jsonl'), clock: () => now, idFactory: (p) => p + '-x' });
  const distributed = new DistributedCapabilityGate({ clock: () => now, leaseTtlMs: 60_000, idFactory: (p) => p + '-x' });
  distributed.registerNode({ nodeId: 'node-a', state: 'draining', capabilities: ['runtime.recover.transaction'] });
  distributed.registerNode({ nodeId: 'node-b', state: 'active', capabilities: ['runtime.recover.transaction'] });
  const transport = new RemoteExecutionTransport({ distributed, clock: () => now, idFactory: (p) => p + '-x' });
  const handoff = new RecoveryHandoffKernel({ lease: recoveryLease, clock: () => now, handoffTtlMs: 30_000, idFactory: (p) => p + '-x' });
  const coordinator = { scan: async () => [{ transactionId: 'tx-1', status: 'active', updatedAt: '2026-09-18T05:00:00.000Z', nodeId: 'node-a' }] };
  const recovered = [];
  const orchestrator = new RecoveryFailoverOrchestrator({
    coordinator, stateReplicator, handoff, recoveryLease, distributed, transport,
    ownerId: 'owner-b', nodeId: 'node-b',
    recoverTransaction: async (transactionId, context) => { recovered.push({ transactionId, context }); return { status: 'succeeded', result: { restored: true } }; },
    clock: () => now, idFactory: (p) => p + '-x', staleAfterMs: 1_000
  });
  return { dir, now, recoveryLease, stateReplicator, distributed, transport, handoff, orchestrator, recovered };
}

test('automatic failover selects a healthy target, fences execution, recovers and replicates terminal state', async (t) => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const result = await f.orchestrator.recover();
  assert.equal(result.status, 'succeeded');
  assert.equal(result.results[0].status, 'succeeded');
  assert.equal(result.results[0].sourceNodeId, 'node-a');
  assert.equal(result.results[0].targetNodeId, 'node-b');
  assert.equal(f.recovered.length, 1);
  assert.equal(f.recovered[0].context.recoveryNodeId, 'node-b');
  assert.equal(f.recovered[0].context.handoffFencingToken, 1);
  assert.equal(f.recovered[0].context.distributedFencingToken, 1);
  assert.equal(f.stateReplicator.get('tx-1').state, 'succeeded');
  assert.equal(f.transport.list().length, 1);
  assert.equal(f.transport.list()[0].status, 'succeeded');
  assert.equal(f.handoff.get('tx-1').state, 'completed');
  assert.equal(f.handoff.get('tx-1').completionStatus, 'succeeded');
});

test('automatic failover refuses a still-active source unless forced', async (t) => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  f.distributed.updateNode({ nodeId: 'node-a', state: 'active' });
  const result = await f.orchestrator.recover();
  assert.equal(result.status, 'blocked');
  assert.equal(result.results[0].error.code, 'FAILOVER_SOURCE_ACTIVE');
});

test('automatic failover blocks when no eligible target exists', async (t) => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  f.distributed.updateNode({ nodeId: 'node-b', state: 'draining' });
  const result = await f.orchestrator.recover();
  assert.equal(result.status, 'blocked');
  assert.equal(result.results[0].error.code, 'FAILOVER_TARGET_UNAVAILABLE');
});

test('concurrent failover requests for the same transaction are deduplicated', async (t) => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  let calls = 0;
  f.orchestrator.recoverTransaction = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { status: 'succeeded', result: { calls } }; };
  const [a, b] = await Promise.all([f.orchestrator.recover(), f.orchestrator.recover()]);
  assert.equal(calls, 1);
  assert.equal(a.results[0].status, 'succeeded');
  assert.equal(b.results[0].status, 'succeeded');
});

test('replicated terminal state blocks unsafe replay', async (t) => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.stateReplicator.append({ transactionId: 'tx-1', sequence: 1, state: 'succeeded', ownerId: 'owner-a', nodeId: 'node-a', fencingToken: 9 });
  const result = await f.orchestrator.recover();
  assert.equal(result.status, 'blocked');
  assert.equal(result.results[0].error.code, 'FAILOVER_TERMINAL_STATE');
});

test('cancelled failover is not reported as success and releases both fences', async (t) => {
  const f = await fixture(); t.after(() => rm(f.dir, { recursive: true, force: true }));
  const controller = new AbortController();
  f.orchestrator.recoverTransaction = async () => { controller.abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }); };
  const result = await f.orchestrator.recover({ signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.results[0].status, 'cancelled');
  assert.equal(f.handoff.get('tx-1').state, 'cancelled');
  assert.throws(() => f.recoveryLease.validate({ executionId: 'tx-1', ownerId: 'owner-b', nodeId: 'node-b', fencingToken: 1 }));
  assert.throws(() => f.distributed.validateLease({ executionId: 'tx-1', nodeId: 'node-b', fencingToken: 1 }));
});
