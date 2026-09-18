import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRequestGuard, RuntimeRequestIdentity, RuntimeDistributedRateLimiter, InMemoryAtomicRateLimitStore } from '../src/index.js';

test('request guard enforces bounded per-principal rate windows', async () => {
  let now = 0;
  const guard = new RuntimeRequestGuard({ clock: () => now, maxRequests: 2, windowMs: 1000 });
  assert.equal((await guard.admit({ method: 'GET', path: '/health', clientKey: 'a' })).decision, 'accepted');
  assert.equal((await guard.admit({ method: 'GET', path: '/health', clientKey: 'a' })).decision, 'accepted');
  const denied = await guard.admit({ method: 'GET', path: '/health', clientKey: 'a' });
  assert.equal(denied.error.code, 'RATE_LIMITED');
  now = 1000;
  assert.equal((await guard.admit({ method: 'GET', path: '/health', clientKey: 'a' })).decision, 'accepted');
});

test('request guard rejects oversized bodies before dispatch', async () => {
  const guard = new RuntimeRequestGuard({ maxBodyBytes: 16 });
  const result = await guard.admit({ method: 'POST', path: '/commands', body: { payload: '01234567890123456789' } });
  assert.equal(result.error.code, 'BODY_TOO_LARGE');
});

test('request guard detects idempotency replay and conflicting reuse', async () => {
  let now = 0;
  const guard = new RuntimeRequestGuard({ clock: () => now, idempotencyTtlMs: 1000 });
  const request = { method: 'POST', path: '/commands', clientKey: 'client-a', headers: { 'idempotency-key': 'req-1' }, body: { command: 'runtime.health' } };
  const first = await guard.admit(request);
  const response = { status: 200, body: { ok: true, value: 'stable' } };
  assert.equal(guard.complete(first, response), true);
  assert.equal((await guard.admit(request)).decision, 'replay');
  const conflict = await guard.admit({ ...request, body: { command: 'runtime.snapshot' } });
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  now = 1000;
  assert.equal((await guard.admit(request)).decision, 'accepted');
});

test('request guard isolates principals and retains bounded idempotency records', async () => {
  const guard = new RuntimeRequestGuard({ maxRequests: 1, maxIdempotencyRecords: 1 });
  const a = await guard.admit({ method: 'POST', path: '/commands', clientKey: 'a', idempotencyKey: '1', body: {} });
  const b = await guard.admit({ method: 'POST', path: '/commands', clientKey: 'b', idempotencyKey: '2', body: {} });
  guard.complete(a, { status: 200 }); guard.complete(b, { status: 200 });
  assert.equal(guard.snapshot().retainedIdempotencyRecords, 1);
  assert.equal(guard.snapshot().activeRateWindows, 2);
});

test('request guard uses trusted proxy forwarding only for configured proxies', async () => {
  const identity = new RuntimeRequestIdentity({ trustedProxies: ['10.0.0.1'], allowForwarded: true });
  const guard = new RuntimeRequestGuard({ identity });
  const trusted = await guard.admit({ method: 'GET', path: '/health', remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(trusted.identity.source, 'forwarded-for');
  assert.equal(trusted.identity.principal, '203.0.113.9');
  const untrusted = await guard.admit({ method: 'GET', path: '/health', remoteAddress: '10.0.0.2', headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(untrusted.identity.source, 'remote-address');
  assert.equal(untrusted.identity.principal, '10.0.0.2');
});

test('request guard can use an atomic shared rate limiter', async () => {
  let now = 0;
  const limiter = new RuntimeDistributedRateLimiter({ store: new InMemoryAtomicRateLimitStore(), maxRequests: 1, windowMs: 1000, clock: () => now });
  const guard = new RuntimeRequestGuard({ clock: () => now, rateLimiter: limiter });
  assert.equal((await guard.admit({ method: 'GET', path: '/health', clientKey: 'a' })).decision, 'accepted');
  assert.equal((await guard.admit({ method: 'GET', path: '/health', clientKey: 'a' })).error.code, 'RATE_LIMITED');
  now = 1000;
  assert.equal((await guard.admit({ method: 'GET', path: '/health', clientKey: 'a' })).decision, 'accepted');
});

test('shared rate limiter fails closed when its atomic store is unavailable', async () => {
  const limiter = new RuntimeDistributedRateLimiter({ store: { consume: async () => { throw new Error('store unavailable'); } } });
  const guard = new RuntimeRequestGuard({ rateLimiter: limiter });
  const result = await guard.admit({ method: 'GET', path: '/health', clientKey: 'a' });
  assert.equal(result.error.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
});
