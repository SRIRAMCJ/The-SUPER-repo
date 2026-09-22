import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableIdempotencyStore, RuntimeRequestGuard } from '../src/index.js';

test('durable idempotency store atomically single-flights concurrent claims across instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-atomic-idempotency-'));
  try {
    const filePath = join(dir, 'idempotency.jsonl');
    const first = await new DurableIdempotencyStore({ filePath, ttlMs: 10_000 }).init();
    const second = await new DurableIdempotencyStore({ filePath, ttlMs: 10_000 }).init();
    const [a, b] = await Promise.all([
      first.claim('client:POST:/commands:req-1', 'fingerprint-a'),
      second.claim('client:POST:/commands:req-1', 'fingerprint-a'),
    ]);
    assert.deepEqual([a.state, b.state].sort(), ['claimed', 'in_progress']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable idempotency claim rejects conflicting reuse and replays completed responses after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-atomic-idempotency-'));
  try {
    const filePath = join(dir, 'idempotency.jsonl');
    const firstStore = await new DurableIdempotencyStore({ filePath, ttlMs: 10_000 }).init();
    const guard = new RuntimeRequestGuard({ idempotencyStore: firstStore, idempotencyTtlMs: 10_000 });
    const request = { method: 'POST', path: '/commands', clientKey: 'client-a', idempotencyKey: 'req-1', body: { command: 'runtime.health' } };
    const admission = await guard.admit(request);
    assert.equal(admission.decision, 'accepted');
    await guard.complete(admission, { status: 200, body: { ok: true } });

    const secondStore = await new DurableIdempotencyStore({ filePath, ttlMs: 10_000 }).init();
    const secondGuard = new RuntimeRequestGuard({ idempotencyStore: secondStore, idempotencyTtlMs: 10_000 });
    const replay = await secondGuard.admit(request);
    assert.equal(replay.decision, 'replay');
    assert.equal(replay.response.status, 200);

    const conflict = await secondGuard.admit({ ...request, body: { command: 'runtime.snapshot' } });
    assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('request guard returns 409 while a durable idempotency request is in flight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-atomic-idempotency-'));
  try {
    const filePath = join(dir, 'idempotency.jsonl');
    const store = await new DurableIdempotencyStore({ filePath, ttlMs: 10_000 }).init();
    const guard = new RuntimeRequestGuard({ idempotencyStore: store, idempotencyTtlMs: 10_000 });
    const request = { method: 'POST', path: '/commands', clientKey: 'client-a', idempotencyKey: 'req-1', body: { command: 'runtime.health' } };
    const first = await guard.admit(request);
    assert.equal(first.decision, 'accepted');
    const second = await guard.admit(request);
    assert.equal(second.decision, 'in_progress');
    assert.ok(second.retryAfterMs > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
