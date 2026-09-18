import test from 'node:test';
import assert from 'node:assert/strict';
import { DistributedCapabilityGate } from '../src/distributed-capability.js';

function clockHarness() {
  let now = new Date('2026-01-01T00:00:00.000Z');
  return { clock: () => now, advance: (ms) => { now = new Date(now.getTime() + ms); } };
}

function setup(options = {}) {
  const time = clockHarness();
  const gate = new DistributedCapabilityGate({ clock: time.clock, ...options });
  gate.registerNode({ nodeId: 'node-a', capabilities: ['tool.echo', 'tool.slow'] });
  return { gate, ...time };
}

test('registers nodes and issues bounded leases with fencing tokens', () => {
  const { gate } = setup({ leaseTtlMs: 1000 });
  const lease = gate.acquireLease({ executionId: 'exec-1', nodeId: 'node-a' });
  assert.equal(lease.fencingToken, 1);
  assert.equal(lease.expiresAt, '2026-01-01T00:00:01.000Z');
  assert.deepEqual(gate.listNodes()[0].capabilities, ['tool.echo', 'tool.slow']);
});

test('prevents split-brain ownership and rejects stale fencing tokens', () => {
  const { gate, advance } = setup({ leaseTtlMs: 1000 });
  gate.registerNode({ nodeId: 'node-b', capabilities: ['tool.echo'] });
  const first = gate.acquireLease({ executionId: 'exec-1', nodeId: 'node-a' });
  assert.throws(() => gate.acquireLease({ executionId: 'exec-1', nodeId: 'node-b' }), /lease is held/i);
  advance(1001);
  const second = gate.acquireLease({ executionId: 'exec-1', nodeId: 'node-b' });
  assert.equal(second.fencingToken, 2);
  assert.throws(() => gate.validateLease({ executionId: 'exec-1', nodeId: 'node-a', fencingToken: first.fencingToken }), /stale/i);
});

test('enforces node capability assignment before handler execution', async () => {
  const { gate } = setup();
  const lease = gate.acquireLease({ executionId: 'exec-2', nodeId: 'node-a' });
  let called = false;
  await assert.rejects(
    gate.execute({ executionId: 'exec-2', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'k', capability: 'tool.unknown', handler: async () => { called = true; } }),
    (error) => error.code === 'CAPABILITY_NOT_ASSIGNED',
  );
  assert.equal(called, false);
});

test('supports security authorization before distributed handler execution', async () => {
  const { gate } = setup({ security: { authorize: async (capability, context) => ({ allowed: capability.id === 'tool.echo' && context.trustLevel === 'trusted' }) } });
  const lease = gate.acquireLease({ executionId: 'exec-3', nodeId: 'node-a' });
  const denied = await gate.execute({ executionId: 'exec-3', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'denied', capability: 'tool.echo', securityContext: { trustLevel: 'untrusted' }, handler: async () => 'must-not-run' });
  assert.equal(denied.status, 'failed');
  assert.equal(denied.error.code, 'SECURITY_DENIED');
  const allowed = await gate.execute({ executionId: 'exec-3', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'allowed', capability: 'tool.echo', securityContext: { trustLevel: 'trusted' }, handler: async () => 'ok' });
  assert.equal(allowed.status, 'succeeded');
  assert.equal(allowed.result, 'ok');
});

test('deduplicates concurrent duplicate deliveries with a single handler execution', async () => {
  const { gate } = setup();
  const lease = gate.acquireLease({ executionId: 'exec-4', nodeId: 'node-a' });
  let calls = 0;
  const handler = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value: 42 };
  };
  const request = { executionId: 'exec-4', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'same', capability: 'tool.echo', handler };
  const [a, b] = await Promise.all([gate.execute(request), gate.execute(request)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(gate.listExecutions().length, 1);
});

test('rejects stale owners from committing after lease fencing changes', async () => {
  const { gate, advance } = setup({ leaseTtlMs: 10 });
  const first = gate.acquireLease({ executionId: 'exec-5', nodeId: 'node-a' });
  let release;
  const pending = gate.execute({
    executionId: 'exec-5', nodeId: 'node-a', fencingToken: first.fencingToken, idempotencyKey: 'slow', capability: 'tool.slow',
    handler: async () => new Promise((resolve) => { release = resolve; }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  advance(11);
  const second = gate.acquireLease({ executionId: 'exec-5', nodeId: 'node-a' });
  assert.equal(second.fencingToken, 2);
  release('late-result');
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'STALE_FENCING_TOKEN');
});

test('cancels before handler execution and retains immutable terminal records', async () => {
  const { gate } = setup();
  const lease = gate.acquireLease({ executionId: 'exec-6', nodeId: 'node-a' });
  const controller = new AbortController();
  controller.abort();
  const result = await gate.execute({ executionId: 'exec-6', nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'cancel', capability: 'tool.echo', signal: controller.signal, handler: async () => 'bad' });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.code, 'EXECUTION_CANCELLED');
  const stored = gate.getExecution({ executionId: 'exec-6', nodeId: 'node-a', idempotencyKey: 'cancel' });
  assert.equal(Object.isFrozen(stored), false);
  stored.error.code = 'mutated';
  assert.equal(gate.getExecution({ executionId: 'exec-6', nodeId: 'node-a', idempotencyKey: 'cancel' }).error.code, 'EXECUTION_CANCELLED');
});

test('expires leases and bounds execution retention', async () => {
  const { gate, advance } = setup({ leaseTtlMs: 10, maxRecords: 2 });
  for (let index = 0; index < 3; index += 1) {
    const executionId = `exec-${index}`;
    const lease = gate.acquireLease({ executionId, nodeId: 'node-a' });
    await gate.execute({ executionId, nodeId: 'node-a', fencingToken: lease.fencingToken, idempotencyKey: 'k', capability: 'tool.echo', handler: async () => index });
    advance(1);
  }
  assert.equal(gate.listExecutions().length, 2);
  advance(20);
  assert.throws(() => gate.validateLease({ executionId: 'exec-2', nodeId: 'node-a', fencingToken: 1 }), /lease expired/i);
});

test('renews and releases only with the current fencing token', () => {
  const { gate, advance } = setup({ leaseTtlMs: 100 });
  const lease = gate.acquireLease({ executionId: 'exec-7', nodeId: 'node-a' });
  advance(50);
  const renewed = gate.renewLease({ executionId: 'exec-7', nodeId: 'node-a', fencingToken: lease.fencingToken });
  assert.equal(renewed.expiresAt, '2026-01-01T00:00:00.150Z');
  assert.throws(() => gate.releaseLease({ executionId: 'exec-7', nodeId: 'node-a', fencingToken: 99 }), /stale/i);
  assert.equal(gate.releaseLease({ executionId: 'exec-7', nodeId: 'node-a', fencingToken: lease.fencingToken }), true);
});
