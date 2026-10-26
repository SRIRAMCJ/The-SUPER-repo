import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneGateway, RuntimeRequestGuard } from '../src/index.js';

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
    cancelExecution: async (id, reason) => ({ type: 'control-action-result', action: 'cancel_execution', executionId: id, result: { executionId: id, reason, status: 'cancelled' } })
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

test('gateway guard replays completed commands and limits the actual HTTP client', async () => {
  let calls = 0;
  const guard = new RuntimeRequestGuard({ maxRequests: 3 });
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane(), requestGuard: guard,
    commands: { list: () => [], execute: async () => ({ ok: true, count: ++calls }) } });
  const address = await gateway.listen();
  try {
    const url = `http://127.0.0.1:${address.port}/commands`;
    const options = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'same', 'x-forwarded-for': 'spoofed' }, body: '{"command":"run"}' };
    const first = await (await fetch(url, options)).json();
    const replay = await (await fetch(url, options)).json();
    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
    assert.equal((await fetch(url, options)).status, 200);
    const limited = await fetch(url, options);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
    assert.equal(calls, 1);
  } finally { await gateway.close(); }
});

test('gateway authorization precedes guard and concurrent duplicates execute once', async () => {
  let calls = 0, release;
  const pending = new Promise((resolve) => { release = resolve; });
  const guard = new RuntimeRequestGuard();
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane(), requestGuard: guard,
    authorize: ({ request }) => request.headers?.token === 'allowed',
    commands: { list: () => [], execute: async () => { calls++; await pending; return { ok: true }; } } });
  const body = { command: 'run' };
  const request = { method: 'POST', path: '/commands', headers: { token: 'allowed', 'idempotency-key': 'once' }, body, remoteAddress: '127.0.0.1' };
  try {
    assert.equal((await gateway.handle({ ...request, headers: { 'idempotency-key': 'once' } })).status, 403);
    const first = gateway.handle(request);
    while (!calls) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await gateway.handle(request)).body.error.code, 'IDEMPOTENCY_IN_PROGRESS');
    assert.equal(calls, 1);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await gateway.handle(request)).status, 200);
    assert.equal(calls, 1);
  } finally { release(); }
});

test('authenticated principals isolate replay and rate limits despite spoofed client fields', async () => {
  let calls = 0;
  const guard = new RuntimeRequestGuard({ maxRequests: 2 });
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane(), requestGuard: guard,
    authorize: ({ request }) => request.headers?.token ? { allowed: true, principal: request.headers.token } : false,
    commands: { list: () => [], execute: async (_name, _input, context) => ({ ok: true, count: ++calls, principal: context.request.clientKey }) } });
  const address = await gateway.listen();
  try {
    const url = `http://127.0.0.1:${address.port}/commands`;
    const send = async (token, spoof = 'victim') => {
      const response = await fetch(url, { method: 'POST', headers: { token, 'idempotency-key': 'same', 'x-client-id': spoof, 'x-forwarded-for': spoof, 'content-type': 'application/json' }, body: '{"command":"run"}' });
      return { status: response.status, body: await response.json() };
    };
    const alice = await send('alice');
    const bob = await send('bob', 'alice');
    assert.equal(alice.body.data.principal, 'auth:alice');
    assert.equal(bob.body.data.principal, 'auth:bob');
    assert.equal((await send('alice', 'bob')).body.data.count, 1);
    assert.equal((await send('bob', 'alice')).body.data.count, 2);
    assert.equal((await send('alice')).status, 429);
    assert.equal((await send('bob')).status, 429);
    assert.equal(calls, 2);
  } finally { await gateway.close(); }
});

test('raw clientKey cannot bypass gateway identity and invalid authorization fails closed', async () => {
  const guard = new RuntimeRequestGuard({ maxRequests: 1 });
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane(), requestGuard: guard });
  const request = { method: 'GET', path: '/health', remoteAddress: '127.0.0.1', clientKey: 'spoofed' };
  assert.equal((await gateway.handle(request)).status, 200);
  assert.equal((await gateway.handle({ ...request, clientKey: 'other' })).status, 429);
  const invalid = new ControlPlaneGateway({ controlPlane: controlPlane(), authorize: () => ({ allowed: true }) });
  assert.equal((await invalid.handle(request)).body.error.code, 'AUTHORIZATION_ERROR');
});

test('non-loopback listener requires a verified principal', async () => {
  const defaultGateway = new ControlPlaneGateway({ controlPlane: controlPlane() });
  await assert.rejects(defaultGateway.listen({ host: '0.0.0.0' }), /requires authorize/);
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane(), authorize: () => true });
  const address = await gateway.listen({ host: '0.0.0.0' });
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'AUTHENTICATED_IDENTITY_REQUIRED');
  } finally { await gateway.close(); }
});

test('expired command outcome is quarantined instead of executed again', async () => {
  let now = 1000;
  let calls = 0;
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane(), requestGuard: new RuntimeRequestGuard({ clock: () => now, idempotencyTtlMs: 100 }),
    commands: { list: () => [], execute: async () => { calls++; now = 1200; return { ok: true }; } } });
  const request = { method: 'POST', path: '/commands', headers: { 'idempotency-key': 'once' }, body: { command: 'work' }, remoteAddress: '127.0.0.1' };
  assert.equal((await gateway.handle(request)).body.error.code, 'IDEMPOTENCY_COMPLETION_FAILED');
  assert.equal((await gateway.handle(request)).body.error.code, 'IDEMPOTENCY_RECOVERY_REQUIRED');
  assert.equal(calls, 1);
});

test('rate window capacity fails closed and expired windows are reclaimed', async () => {
  let now = 1000;
  const guard = new RuntimeRequestGuard({ clock: () => now, maxRateWindows: 2, windowMs: 100 });
  const gateway = new ControlPlaneGateway({ controlPlane: controlPlane(), requestGuard: guard,
    authorize: ({ request }) => ({ allowed: true, principal: request.headers.user }) });
  const call = (user) => gateway.handle({ method: 'GET', path: '/health', headers: { user } });
  assert.equal((await call('a')).status, 200);
  assert.equal((await call('b')).status, 200);
  assert.equal((await call('c')).body.error.code, 'RATE_LIMIT_CAPACITY');
  assert.equal(guard.snapshot().activeRateWindows, 2);
  now = 1100;
  assert.equal((await call('c')).status, 200);
  assert.equal(guard.snapshot().activeRateWindows, 1);
});

test('completed replay capacity is reclaimed after expiry without replaying stale responses', async () => {
  let now = 1000;
  const guard = new RuntimeRequestGuard({ clock: () => now, maxIdempotencyRecords: 1, idempotencyTtlMs: 100 });
  const request = (key) => ({ method: 'POST', path: '/commands', clientKey: 'client', idempotencyKey: key, body: {} });
  const first = await guard.admit(request('one'));
  assert.equal(await guard.complete(first, { status: 200 }), true);
  assert.equal((await guard.admit(request('two'))).error.code, 'IDEMPOTENCY_CAPACITY');
  now = 1100;
  assert.equal((await guard.admit(request('two'))).decision, 'accepted');
  assert.equal((await guard.admit(request('one'))).error.code, 'IDEMPOTENCY_CAPACITY');
});
