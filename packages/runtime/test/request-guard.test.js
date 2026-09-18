import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRequestGuard } from '../src/index.js';

test('request guard enforces bounded per-principal rate windows', () => {
  let now = 0;
  const guard = new RuntimeRequestGuard({ clock: () => now, maxRequests: 2, windowMs: 1000 });
  assert.equal(guard.admit({ method: 'GET', path: '/health', clientKey: 'a' }).decision, 'accepted');
  assert.equal(guard.admit({ method: 'GET', path: '/health', clientKey: 'a' }).decision, 'accepted');
  const denied = guard.admit({ method: 'GET', path: '/health', clientKey: 'a' });
  assert.equal(denied.decision, 'denied');
  assert.equal(denied.error.code, 'RATE_LIMITED');
  now = 1000;
  assert.equal(guard.admit({ method: 'GET', path: '/health', clientKey: 'a' }).decision, 'accepted');
});

test('request guard rejects oversized bodies before dispatch', () => {
  const guard = new RuntimeRequestGuard({ maxBodyBytes: 16 });
  const result = guard.admit({ method: 'POST', path: '/commands', body: { payload: '01234567890123456789' } });
  assert.equal(result.decision, 'denied');
  assert.equal(result.error.code, 'BODY_TOO_LARGE');
});

test('request guard detects idempotency replay and conflicting reuse', () => {
  let now = 0;
  const guard = new RuntimeRequestGuard({ clock: () => now, idempotencyTtlMs: 1000 });
  const request = { method: 'POST', path: '/commands', clientKey: 'client-a', headers: { 'idempotency-key': 'req-1' }, body: { command: 'runtime.health' } };
  const first = guard.admit(request);
  assert.equal(first.decision, 'accepted');
  const response = { status: 200, body: { ok: true, value: 'stable' } };
  assert.equal(guard.complete(first, response), true);
  const replay = guard.admit(request);
  assert.equal(replay.decision, 'replay');
  assert.deepEqual(replay.response, response);
  const conflict = guard.admit({ ...request, body: { command: 'runtime.snapshot' } });
  assert.equal(conflict.decision, 'denied');
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  now = 1000;
  assert.equal(guard.admit(request).decision, 'accepted');
});

test('request guard isolates principals and retains bounded idempotency records', () => {
  const guard = new RuntimeRequestGuard({ maxRequests: 1, maxIdempotencyRecords: 1 });
  const a = guard.admit({ method: 'POST', path: '/commands', clientKey: 'a', idempotencyKey: '1', body: {} });
  const b = guard.admit({ method: 'POST', path: '/commands', clientKey: 'b', idempotencyKey: '2', body: {} });
  assert.equal(a.decision, 'accepted');
  assert.equal(b.decision, 'accepted');
  guard.complete(a, { status: 200 });
  guard.complete(b, { status: 200 });
  const snapshot = guard.snapshot();
  assert.equal(snapshot.retainedIdempotencyRecords, 1);
  assert.equal(snapshot.activeRateWindows, 2);
});

test('request guard fingerprints the normalized request path', () => {
  const guard = new RuntimeRequestGuard();
  const first = guard.admit({ method: 'POST', path: '/commands?x=1', clientKey: 'a', idempotencyKey: 'k', body: { b: 2 } });
  guard.complete(first, { status: 201 });
  const second = guard.admit({ method: 'POST', path: '/commands?x=2', clientKey: 'a', idempotencyKey: 'k', body: { b: 2 } });
  assert.equal(second.decision, 'replay');
});
