import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionRecoveryCoordinator } from '../src/execution-recovery-coordinator.js';

function durable(states) { return { load: async () => structuredClone(states) }; }
test('scan identifies only stale active transactions', async () => {
  const now = new Date('2026-09-17T12:00:00.000Z');
  const coordinator = new ExecutionRecoveryCoordinator({
    durableState: durable([
      { transactionId: 'stale', status: 'active', updatedAt: '2026-09-17T11:00:00.000Z' },
      { transactionId: 'fresh', status: 'active', updatedAt: '2026-09-17T11:59:59.000Z' },
      { transactionId: 'done', status: 'committed', updatedAt: '2026-09-17T10:00:00.000Z' }
    ]),
    transaction: { recover: async () => ({ status: 'rolled_back' }) },
    clock: () => now,
    staleAfterMs: 60_000
  });
  assert.deepEqual((await coordinator.scan()).map(x => x.transactionId), ['stale']);
});

test('recovery delegates stale transaction and records attempt', async () => {
  const now = new Date('2026-09-17T12:00:00.000Z');
  let recovered = 0;
  const coordinator = new ExecutionRecoveryCoordinator({
    durableState: durable([{ transactionId: 't1', status: 'active', updatedAt: '2026-09-17T11:00:00.000Z' }]),
    transaction: { recover: async () => { recovered++; return { status: 'rolled_back' }; } },
    clock: () => now,
    staleAfterMs: 60_000
  });
  const result = await coordinator.recover();
  assert.equal(recovered, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(coordinator.attempts('t1'), 1);
});

test('attempt limit blocks repeated recovery unless forced', async () => {
  const now = new Date('2026-09-17T12:00:00.000Z');
  let calls = 0;
  const state = { transactionId: 't1', status: 'active', updatedAt: '2026-09-17T11:00:00.000Z' };
  const coordinator = new ExecutionRecoveryCoordinator({
    durableState: durable([state]), transaction: { recover: async () => { calls++; return { status: 'rolled_back' }; } },
    clock: () => now, staleAfterMs: 0, maxAttempts: 1
  });
  await coordinator.recover(); await coordinator.recover();
  assert.equal(calls, 1);
  const forced = await coordinator.recover({ force: true });
  assert.equal(calls, 2);
  assert.equal(forced.results[0].status, 'rolled_back');
});

test('unhealthy supervisor blocks recovery', async () => {
  let calls = 0;
  const coordinator = new ExecutionRecoveryCoordinator({
    durableState: durable([{ transactionId: 't1', status: 'active', updatedAt: '2020-01-01T00:00:00.000Z' }]),
    transaction: { recover: async () => { calls++; } },
    supervisor: { health: async () => ({ state: 'failed' }) }
  });
  const result = await coordinator.recover();
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'SUPERVISOR_UNHEALTHY');
  assert.equal(calls, 0);
});

test('recovery cancellation stops remaining candidates', async () => {
  const controller = new AbortController();
  const coordinator = new ExecutionRecoveryCoordinator({
    durableState: durable([
      { transactionId: 'a', status: 'active', updatedAt: '2020-01-01T00:00:00.000Z' },
      { transactionId: 'b', status: 'active', updatedAt: '2020-01-01T00:00:00.000Z' }
    ]),
    transaction: { recover: async () => { controller.abort(); return { status: 'rolled_back' }; } },
    staleAfterMs: 0
  });
  const result = await coordinator.recover({ signal: controller.signal });
  assert.equal(result.status, 'blocked');
  assert.equal(result.results.length, 1);
});

test('history is bounded and immutable', async () => {
  const coordinator = new ExecutionRecoveryCoordinator({
    durableState: durable([]), transaction: { recover: async () => ({}) }, maxHistory: 2
  });
  await coordinator.recover(); await coordinator.recover(); await coordinator.recover();
  assert.equal(coordinator.history().length, 2);
  assert.equal(Object.isFrozen(coordinator.history()), true);
});
