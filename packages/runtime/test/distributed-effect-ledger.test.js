import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DistributedEffectLedger, fingerprintEffect } from '../src/distributed-effect-ledger.js';

test('single owner, committed replay, and stale fencing', async () => {
  const l = new DistributedEffectLedger();
  const fp = fingerprintEffect({ executionId: 'e1', operation: 'write', input: { a: 1 } });
  const a = await l.claim('fx1', fp, { executionId: 'e1', operation: 'write' });
  assert.equal(a.state, 'claimed');
  await l.commit('fx1', a.record.claimToken, { receipt: 'r1' });
  assert.equal((await l.claim('fx1', fp, { executionId: 'e1', operation: 'write' })).state, 'replay');
  await assert.rejects(() => l.commit('fx1', a.record.claimToken, { receipt: 'r2' }), /no longer pending|stale/i);
});

test('fingerprint and execution scope mismatches conflict', async () => {
  const l = new DistributedEffectLedger();
  const fp1 = fingerprintEffect({ executionId: 'e1', operation: 'write', input: { a: 1 } });
  const fp2 = fingerprintEffect({ executionId: 'e1', operation: 'write', input: { a: 2 } });
  await l.claim('fx', fp1, { executionId: 'e1', operation: 'write' });
  assert.equal((await l.claim('fx', fp2, { executionId: 'e1', operation: 'write' })).state, 'conflict');
  assert.equal((await l.claim('fx', fp1, { executionId: 'e2', operation: 'write' })).state, 'conflict');
});

test('concurrent in-memory claims have one owner', async () => {
  const l = new DistributedEffectLedger();
  const fp = fingerprintEffect({ executionId: 'e', operation: 'send', input: { id: 7 } });
  const results = await Promise.all(Array.from({ length: 20 }, () => l.claim('fx', fp, { executionId: 'e', operation: 'send' })));
  assert.equal(results.filter(r => r.state === 'claimed').length, 1);
  assert.equal(results.filter(r => r.state === 'in_progress').length, 19);
});

test('expired claim recovery permits a new fenced generation', async () => {
  let now = 1000;
  const l = new DistributedEffectLedger({ clock: () => now, ttlMs: 100 });
  const fp = fingerprintEffect({ executionId: 'e', operation: 'publish', input: { id: 1 } });
  const a = await l.claim('fx', fp, { executionId: 'e', operation: 'publish' });
  now = 1200;
  assert.equal((await l.recover('fx')).state, 'recovered');
  const b = await l.claim('fx', fp, { executionId: 'e', operation: 'publish' });
  assert.equal(b.state, 'claimed'); assert.equal(b.record.generation, a.record.generation + 1);
});

test('retryable failures reclaim; permanent failures do not', async () => {
  const l = new DistributedEffectLedger();
  const fp = fingerprintEffect({ executionId: 'e', operation: 'index', input: { id: 1 } });
  const a = await l.claim('fx1', fp); await l.fail('fx1', a.record.claimToken, new Error('temporary'), { retryable: true });
  assert.equal((await l.claim('fx1', fp)).state, 'claimed');
  const b = await l.claim('fx2', fp); await l.fail('fx2', b.record.claimToken, new Error('permanent'), { retryable: false });
  assert.equal((await l.claim('fx2', fp)).state, 'failed');
});

test('file ledger serializes duplicate claims and survives restart', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), 'effect-ledger-')); const filePath = path.join(dir, 'ledger.jsonl');
  try {
    const fp = fingerprintEffect({ executionId: 'e9', operation: 'email', input: { id: 42 } });
    const a = new DistributedEffectLedger({ filePath }); const b = new DistributedEffectLedger({ filePath });
    await Promise.all([a.init(), b.init()]);
    const results = await Promise.all([a.claim('fx9', fp, { executionId: 'e9', operation: 'email' }), b.claim('fx9', fp, { executionId: 'e9', operation: 'email' })]);
    assert.equal(results.filter(r => r.state === 'claimed').length, 1);
    const owner = results.find(r => r.state === 'claimed');
    await a.commit('fx9', owner.record.claimToken, { ok: true });
    const restarted = new DistributedEffectLedger({ filePath }); await restarted.init();
    assert.equal((await restarted.claim('fx9', fp, { executionId: 'e9', operation: 'email' })).state, 'replay');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('canonical fingerprints ignore object key order', () => {
  const a = fingerprintEffect({ executionId: 'e', operation: 'op', input: { z: 1, a: { y: 2, x: 3 } } });
  const b = fingerprintEffect({ executionId: 'e', operation: 'op', input: { a: { x: 3, y: 2 }, z: 1 } });
  assert.equal(a, b);
});


test('effect keys longer than the bounded key size are rejected rather than truncated', async () => {
  const l = new DistributedEffectLedger();
  const fp = fingerprintEffect({ executionId: 'e', operation: 'op', input: { id: 1 } });
  await assert.rejects(() => l.claim('x'.repeat(513), fp), /512/);
});

test('non-JSON fingerprint values are rejected deterministically', () => {
  assert.throws(() => fingerprintEffect({ executionId: 'e', operation: 'op', input: { bad: undefined } }), /JSON-like/);
});

test('handler failure is preserved if ledger failure recording also fails', async () => {
  const l = new DistributedEffectLedger();
  const fp = fingerprintEffect({ executionId: 'e', operation: 'op', input: { id: 2 } });
  const originalFail = l.fail.bind(l);
  l.fail = async () => { throw new Error('ledger recording failed'); };
  await assert.rejects(() => l.execute('fx', fp, async () => { throw new Error('handler failed'); }), error => {
    assert.equal(error.message, 'handler failed');
    assert.equal(error.ledgerFailure?.message, 'ledger recording failed');
    return true;
  });
  l.fail = originalFail;
});
