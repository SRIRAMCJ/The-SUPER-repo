import test from 'node:test';
import assert from 'node:assert/strict';
import { DistributedCapabilityGate } from '../src/distributed-capability.js';
import { RemoteExecutionTransport } from '../src/remote-transport.js';

function setup() {
  let now = new Date('2026-09-17T00:00:00.000Z');
  const distributed = new DistributedCapabilityGate({ clock: () => now, leaseTtlMs: 5_000 });
  distributed.registerNode({ nodeId: 'node-a', capabilities: ['compute'] });
  const lease = distributed.acquireLease({ executionId: 'exec-1', nodeId: 'node-a' });
  return { distributed, lease, advance(ms) { now = new Date(now.getTime() + ms); } };
}

test('dispatches through the distributed boundary and preserves correlation', async () => {
  const { distributed, lease } = setup();
  const transport = new RemoteExecutionTransport({ distributed, idFactory: () => 'req-1' });
  const result = await transport.dispatch({ executionId: 'exec-1', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'idem-1', capability: 'compute', input: { value: 2 }, handler: async ({ input }) => ({ value: input.value * 2 }) });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.requestId, 'req-1');
  assert.deepEqual(result.result, { value: 4 });
});

test('deduplicates the same remote request before re-execution', async () => {
  const { distributed, lease } = setup();
  const transport = new RemoteExecutionTransport({ distributed });
  let calls = 0;
  const request = { requestId: 'req-dup', executionId: 'exec-1', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'idem-dup', capability: 'compute', handler: async () => { calls += 1; return 'ok'; } };
  const first = await transport.dispatch(request);
  const second = await transport.dispatch(request);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
});

test('propagates parent cancellation to the remote handler', async () => {
  const { distributed, lease } = setup();
  const transport = new RemoteExecutionTransport({ distributed });
  const controller = new AbortController();
  const resultPromise = transport.dispatch({ requestId: 'req-cancel', executionId: 'exec-1', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'idem-cancel', capability: 'compute', signal: controller.signal, handler: async ({ signal }) => { await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(signal.aborted, true); return 'ignored'; } });
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
});

test('classifies transport timeout and bounds request retention', async () => {
  const { distributed, lease } = setup();
  const transport = new RemoteExecutionTransport({ distributed, maxRecords: 1 });
  const result = await transport.dispatch({ requestId: 'req-timeout', executionId: 'exec-1', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'idem-timeout', capability: 'compute', timeoutMs: 1, handler: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return 'late'; } });
  assert.equal(result.status, 'timed_out');
  await transport.dispatch({ requestId: 'req-next', executionId: 'exec-1', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'idem-next', capability: 'compute', handler: async () => 'next' });
  assert.equal(transport.list().length, 1);
  assert.equal(transport.get('req-timeout'), null);
});

test('rejects stale distributed ownership before remote dispatch', async () => {
  const { distributed, lease } = setup();
  distributed.acquireLease({ executionId: 'exec-1', nodeId: 'node-a' });
  const transport = new RemoteExecutionTransport({ distributed });
  await assert.rejects(() => transport.dispatch({ requestId: 'req-stale', executionId: 'exec-1', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'idem-stale', capability: 'compute', handler: async () => 'never' }), { code: 'STALE_FENCING_TOKEN' });
});
