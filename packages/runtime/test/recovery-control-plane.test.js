import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeControlPlane, RuntimeOperations, RuntimeCommandBus, ControlPlaneGateway } from '../src/index.js';

function observability() {
  return { getMetrics: () => ({ activeExecutions: 0, metrics: [] }), getEvents: () => [], getTraces: () => [] };
}

function recoveryKernel() {
  const calls = [];
  return { calls, snapshot: async () => ({ schemaVersion: '0.1.0', state: 'idle', history: [] }), recover: async (input) => { calls.push(input); return { schemaVersion: '0.1.0', type: 'runtime-recovery-result', status: 'succeeded', recoveryId: 'recovery-1' }; } };
}

test('control plane exposes recovery state and delegates recovery without owning duplicate state', async () => {
  const recovery = recoveryKernel();
  const cp = new RuntimeControlPlane({ observability: observability(), recoveryKernel: recovery });
  assert.equal((await cp.getRecovery()).configured, true);
  const result = await cp.recover({ reason: 'operator restart' });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(recovery.calls, [{ reason: 'operator restart' }]);
});

test('command bus routes recovery with correlation and validates bounded recovery controls', async () => {
  const recovery = recoveryKernel();
  const cp = new RuntimeControlPlane({ observability: observability(), recoveryKernel: recovery });
  const operations = new RuntimeOperations({ controlPlane: cp });
  const bus = new RuntimeCommandBus({ controlPlane: cp, operations, correlationId: () => 'generated-corr' });
  assert.ok(bus.list().some((item) => item.command === 'runtime.recovery'));
  assert.ok(bus.list().some((item) => item.command === 'runtime.recover'));
  const result = await bus.execute('runtime.recover', { reason: 'health recovery', deadlineMs: 5000, pollMs: 5 }, { correlationId: 'corr-42' });
  assert.equal(result.ok, true);
  assert.equal(result.correlationId, 'corr-42');
  assert.equal(recovery.calls[0].readinessCorrelationId, 'corr-42');
  const invalid = await bus.execute('runtime.recover', { deadlineMs: -1 }, { correlationId: 'corr-43' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_INPUT');
});

test('gateway exposes recovery read and control routes through the command bus', async () => {
  const recovery = recoveryKernel();
  const cp = new RuntimeControlPlane({ observability: observability(), recoveryKernel: recovery });
  const operations = new RuntimeOperations({ controlPlane: cp });
  const commands = new RuntimeCommandBus({ controlPlane: cp, operations, correlationId: () => 'gateway-corr' });
  const gateway = new ControlPlaneGateway({ controlPlane: cp, operations, commands });
  const state = await gateway.handle({ method: 'GET', path: '/recovery' });
  assert.equal(state.status, 200);
  assert.equal(state.body.data.configured, true);
  const result = await gateway.handle({ method: 'POST', path: '/recovery', body: { reason: 'gateway recovery', deadlineMs: 1000 } });
  assert.equal(result.status, 202);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.correlationId, 'gateway-corr');
  assert.equal(recovery.calls[0].reason, 'gateway recovery');
});

test('gateway rejects malformed recovery controls before invoking recovery', async () => {
  const recovery = recoveryKernel();
  const cp = new RuntimeControlPlane({ observability: observability(), recoveryKernel: recovery });
  const gateway = new ControlPlaneGateway({ controlPlane: cp });
  const result = await gateway.handle({ method: 'POST', path: '/recovery', body: { pollMs: -1 } });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_INPUT');
  assert.equal(recovery.calls.length, 0);
});
