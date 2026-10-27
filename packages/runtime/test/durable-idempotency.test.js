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

test('expired pending claims require reconciliation and stale workers cannot complete them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-claim-fencing-'));
  let now = 1000;
  try {
    const store = await new DurableIdempotencyStore({ filePath: join(dir, 'journal'), clock: () => now, ttlMs: 100, maxRecords: 1 }).init();
    const old = await store.claim('request', 'same');
    await assert.rejects(store.claim('other', 'other'), { code: 'IDEMPOTENCY_CAPACITY' });
    assert.equal((await store.claim('request', 'same')).state, 'in_progress');
    now = 1200;
    assert.equal((await store.claim('request', 'same')).state, 'recovery_required');
    await assert.rejects(store.claim('other', 'other'), { code: 'IDEMPOTENCY_CAPACITY' });
    await assert.rejects(store.delete('request'), { code: 'IDEMPOTENCY_CLAIM_REQUIRED' });
    assert.equal(await store.completeClaim('request', 'same', old.record.claimToken, 'stale'), false);
    await store.compact();
    const reopened = await new DurableIdempotencyStore({ filePath: join(dir, 'journal'), clock: () => now }).init();
    assert.equal((await reopened.claim('request', 'same')).state, 'recovery_required');
    assert.equal(await reopened.reconcileClaim('request', 'same', 'wrong', 'fresh', { reason: 'effect verified' }), false);
    assert.equal(await reopened.reconcileClaim('request', 'same', old.record.claimToken, 'fresh', { reason: 'effect verified' }), true);
    assert.equal((await reopened.claim('request', 'same')).record.response, 'fresh');
    assert.equal((await reopened.get('request')).reconciliation.reason, 'effect verified');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('releasing a verified no-effect claim permits a new token and fences the old one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-claim-release-'));
  let now = 1000;
  try {
    const store = await new DurableIdempotencyStore({ filePath: join(dir, 'journal'), clock: () => now, ttlMs: 100 }).init();
    const old = await store.claim('request', 'same');
    now = 1200;
    assert.equal(await store.releaseClaim('request', 'same', old.record.claimToken, 'no effect found'), true);
    const next = await store.claim('request', 'same');
    assert.notEqual(next.record.claimToken, old.record.claimToken);
    assert.equal(await store.completeClaim('request', 'same', old.record.claimToken, 'stale'), false);
    assert.equal(await store.completeClaim('request', 'same', next.record.claimToken, 'new'), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('in-memory guard holds expired pending claims until the owner is reconciled', async () => {
  let now = 1000;
  const guard = new RuntimeRequestGuard({ clock: () => now, idempotencyTtlMs: 100, maxIdempotencyRecords: 1 });
  const request = { method: 'POST', path: '/commands', clientKey: 'client', idempotencyKey: 'one', body: {} };
  const claim = await guard.admit(request);
  now = 1200;
  assert.equal((await guard.admit(request)).decision, 'recovery_required');
  assert.equal(await guard.complete(claim, { status: 200 }), false);
  assert.equal((await guard.admit({ ...request, idempotencyKey: 'two' })).error.code, 'IDEMPOTENCY_CAPACITY');
});

test('claim ownership is atomic across separate Node processes', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'super-process-claims-'));
  try {
    const moduleUrl = new URL('../src/durable-idempotency.js', import.meta.url).href;
    const script = `import { DurableIdempotencyStore } from ${JSON.stringify(moduleUrl)}; const store = await new DurableIdempotencyStore({filePath:process.argv[1]}).init(); console.log((await store.claim('key','fp')).state);`;
    const output = await Promise.all([1, 2].map(() => run(process.execPath, ['--input-type=module', '-e', script, join(dir, 'journal')])));
    assert.deepEqual(output.map((x) => x.stdout.trim()).sort(), ['claimed', 'in_progress']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a killed claimant leaves an ambiguous effect blocked after expiry', async () => {
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'super-ambiguous-claim-'));
  const filePath = join(dir, 'journal');
  const moduleUrl = new URL('../src/durable-idempotency.js', import.meta.url).href;
  const script = `import {DurableIdempotencyStore} from ${JSON.stringify(moduleUrl)}; const store=await new DurableIdempotencyStore({filePath:process.argv[1],clock:()=>1000,ttlMs:100}).init(); await store.claim('effect','fp'); console.log('claimed'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('claimant exited early'))); });
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const replacement = await new DurableIdempotencyStore({ filePath, clock: () => 1200, ttlMs: 100 }).init();
    assert.equal((await replacement.claim('effect', 'fp')).state, 'recovery_required');
  } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test('kernel lock times out and a killed owner releases it', async () => {
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'super-lock-timeout-'));
  const filePath = join(dir, 'journal');
  const script = `import {open} from 'node:fs/promises'; import {spawn} from 'node:child_process'; const h=await open(process.argv[1]+'.flock','a+'); const child=spawn('flock',['-x','3'],{stdio:['ignore','ignore','ignore',h.fd]}); child.on('close',code=>{if(code)process.exit(2);console.log('locked');setInterval(()=>{},1000)});`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', script, filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', () => reject(new Error('holder exited early'))); });
    const store = new DurableIdempotencyStore({ filePath, clock: () => 0, lockTimeoutMs: 20, lockRetryMs: 2 });
    await assert.rejects(store.init(), { code: 'IDEMPOTENCY_LOCK_TIMEOUT' });
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    await store.init();
    assert.equal((await store.claim('key', 'fp', { expiresAt: 100 })).state, 'claimed');
  } finally { holder.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test('observed journal disappearance fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-idempotency-loss-'));
  const filePath = join(dir, 'journal');
  try {
    const store = await new DurableIdempotencyStore({ filePath }).init();
    await store.claim('key', 'fp');
    await rm(filePath);
    await assert.rejects(store.claim('other', 'fp'), { code: 'ENOENT' });
    await assert.rejects(new DurableIdempotencyStore({ filePath }).init(), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('parent retains the flock after the locking child exits', async () => {
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'super-retained-lock-'));
  const filePath = join(dir, 'journal');
  try {
    const ready = await new DurableIdempotencyStore({ filePath }).init();
    await ready.claim('initial', 'fp');
    const script = `import {DurableIdempotencyStore} from ${JSON.stringify(new URL('../src/durable-idempotency.js', import.meta.url).href)}; const store=await new DurableIdempotencyStore({filePath:process.argv[1],clock:()=>{console.log('inside');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);return Date.now()}}).init(); await store.get('initial');`;
    const holder = spawn(process.execPath, ['--input-type=module', '-e', script, filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
      const contender = new DurableIdempotencyStore({ filePath, lockTimeoutMs: 20 });
      await assert.rejects(contender.init(), { code: 'IDEMPOTENCY_LOCK_TIMEOUT' });
    } finally { holder.kill('SIGKILL'); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('in-memory guard single-flights requests and distinguishes query strings', async () => {
  const guard = new RuntimeRequestGuard();
  const request = { method: 'POST', path: '/run?mode=a', clientKey: 'trusted-user', idempotencyKey: 'same', body: {} };
  const owner = await guard.admit(request);
  assert.equal((await guard.admit(request)).decision, 'in_progress');
  assert.equal((await guard.admit({ ...request, path: '/run?mode=b' })).decision, 'accepted');
  assert.equal(await guard.complete({ ...owner, claimToken: 'wrong' }, { status: 200 }), false);
  assert.equal(await guard.complete(owner, { status: 200 }), true);
  assert.equal((await guard.admit(request)).decision, 'replay');
});

test('untrusted client identity headers cannot change the host-provided principal', async () => {
  const guard = new RuntimeRequestGuard();
  const request = { method: 'POST', path: '/run', clientKey: 'trusted-user', idempotencyKey: 'same', body: {} };
  const owner = await guard.admit({ ...request, headers: { 'x-client-id': 'victim' } });
  await guard.complete(owner, { status: 200 });
  assert.equal((await guard.admit({ ...request, headers: { 'x-client-id': 'someone-else' } })).decision, 'replay');
});
