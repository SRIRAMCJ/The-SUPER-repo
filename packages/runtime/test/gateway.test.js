import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneGateway } from '../src/index.js';

function controlPlane() {
  return {
    observability: {
      getMetrics: () => ({ activeExecutions: 1, metrics: [{ name: 'executions.started', value: 2 }] }),
      getTraces: (filter = {}) => [{ executionId: 'exec-1', name: 'task', ...filter }],
      getEvents: (filter = {}) => [{ executionId: 'exec-1', type: 'execution.started', ...filter }]
    },
    getHealth: () => ({ type: 'runtime-health', status: 'healthy' }),
    getExecutions: (filter = {}) => [{ executionId: 'exec-1', status: 'running', ...filter }],
    getEvolution: async () => ({ active: 0, controls: [] }),
    snapshot: async () => ({ type: 'runtime-control-plane-snapshot', health: { status: 'healthy' } }),
    cancelExecution: async (id, reason) => ({ executionId: id, reason, status: 'cancelled' })
  };
}

test('gateway exposes read-only runtime views through a stable envelope', async () => {
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane() });
  const health = await gateway.handle({ method: 'GET', path: '/health' });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.schemaVersion, '0.1.0');
  assert.equal(health.body.data.status, 'healthy');
  const executions = await gateway.handle({ method: 'GET', path: '/executions?status=running&limit=5' });
  assert.equal(executions.body.data[0].status, 'running');
  assert.equal(executions.body.data[0].limit, 5);
});

test('gateway exposes operation and command catalogs', async () => {
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane() });
  const operations = await gateway.handle({ method: 'GET', path: '/operations' });
  const commands = await gateway.handle({ method: 'GET', path: '/commands' });
  assert.ok(operations.body.data.some((item) => item.id === 'runtime.cancel'));
  assert.ok(commands.body.data.some((item) => item.command === 'runtime.diagnostics'));
});

test('gateway executes runtime commands with a structured result', async () => {
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane() });
  const result = await gateway.handle({ method: 'POST', path: '/commands', body: { command: 'runtime.health', correlationId: 'http-corr' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.correlationId, 'http-corr');
  assert.equal(result.body.data.data.status, 'healthy');
});

test('gateway maps command validation and lookup failures to HTTP errors', async () => {
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane() });
  const missing = await gateway.handle({ method: 'POST', path: '/commands', body: { command: 'runtime.missing' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'COMMAND_NOT_FOUND');
  const invalid = await gateway.handle({ method: 'POST', path: '/commands', body: { command: 'runtime.cancel', input: {} } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_INPUT');
});

test('gateway enforces authorization before dispatch', async () => {
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane(), authorize: () => false });
  const result = await gateway.handle({ method: 'GET', path: '/snapshot' });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'FORBIDDEN');
});

test('gateway executes explicit cancellation action with a reason', async () => {
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane() });
  const result = await gateway.handle({ method: 'POST', path: '/executions/exec-1/cancel', body: { reason: 'operator intervention' } });
  assert.equal(result.status, 202);
  assert.equal(result.body.data.result.status, 'cancelled');
  assert.equal(result.body.data.result.reason, 'operator intervention');
});

test('gateway returns structured errors for unknown routes and invalid input', async () => {
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane() });
  const missing = await gateway.handle({ method: 'GET', path: '/unknown' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  const invalid = await gateway.handle({ method: 'POST', path: '/executions//cancel', body: 'bad' });
  assert.equal(invalid.status, 404);
});

test('gateway serves the command contract over a real local HTTP listener', async () => {
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane() });
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'runtime.health' }) });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.data.data.status, 'healthy');
  } finally { await gateway.close(); }
});

test('gateway lifecycle prevents duplicate listeners and closes cleanly', async () => {
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane() });
  await gateway.listen({ host: '127.0.0.1', port: 0 });
  await assert.rejects(() => gateway.listen({ host: '127.0.0.1', port: 0 }), /already listening/);
  await gateway.close();
  await gateway.close();
});
