import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DistributedCoordinationKernel, coordinationFingerprint } from '../src/distributed-coordination-kernel.js';

test('single owner and renewal are fenced by identity and token', async () => {
  const k = new DistributedCoordinationKernel();
  const a = await k.acquire('repo-write', { ownerId: 'worker-a', requestId: 'r1' });
  assert.equal(a.state, 'acquired');
  const renewed = await k.renew('repo-write', { ownerId: 'worker-a', requestId: 'r1', fencingToken: a.record.fencingToken });
  assert.equal(renewed.state, 'renewed');
  assert.equal((await k.renew('repo-write', { ownerId: 'worker-b', requestId: 'r2', fencingToken: a.record.fencingToken })).state, 'fenced');
});

test('concurrent acquisition has one owner and deterministic fencing generation', async () => {
  const k = new DistributedCoordinationKernel();
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => k.acquire('resource', { ownerId: 'w' + i, requestId: 'r' + i })));
  assert.equal(results.filter(r => r.state === 'acquired').length, 1);
  assert.equal(results.filter(r => r.state === 'busy').length, 24);
  assert.equal((await k.inspect('resource')).fencingToken, 1);
});

test('expired lease can be reacquired with a higher fencing token', async () => {
  let now = 1000;
  const k = new DistributedCoordinationKernel({ clock: () => now, leaseMs: 100 });
  const a = await k.acquire('resource', { ownerId: 'a', requestId: '1' });
  now = 1200;
  const b = await k.acquire('resource', { ownerId: 'b', requestId: '2' });
  assert.equal(b.state, 'acquired'); assert.equal(b.record.fencingToken, a.record.fencingToken + 1);
  assert.equal(b.record.generation, a.record.generation + 1);
});

test('force fencing invalidates the current owner', async () => {
  const k = new DistributedCoordinationKernel();
  const a = await k.acquire('resource', { ownerId: 'a', requestId: '1' });
  const f = await k.forceFence('resource', { reason: 'worker-failure' });
  assert.equal(f.state, 'fenced');
  assert.equal((await k.release('resource', { ownerId: 'a', requestId: '1', fencingToken: a.record.fencingToken })).state, 'fenced');
});

test('file-backed coordination survives restart and serializes acquisition', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), 'coordination-')); const filePath = path.join(dir, 'coordination.jsonl');
  try {
    const a = new DistributedCoordinationKernel({ filePath }); const b = new DistributedCoordinationKernel({ filePath });
    await Promise.all([a.init(), b.init()]);
    const results = await Promise.all([a.acquire('r', { ownerId: 'a', requestId: '1' }), b.acquire('r', { ownerId: 'b', requestId: '2' })]);
    assert.equal(results.filter(r => r.state === 'acquired').length, 1);
    const restarted = new DistributedCoordinationKernel({ filePath }); await restarted.init();
    assert.equal((await restarted.inspect('r')).status, 'held');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('coordination fingerprints are canonical', () => {
  assert.equal(
    coordinationFingerprint({ resource: 'r', ownerId: 'a', requestId: '1', fencingToken: 1 }),
    coordinationFingerprint({ fencingToken: 1, requestId: '1', ownerId: 'a', resource: 'r' }),
  );
});
