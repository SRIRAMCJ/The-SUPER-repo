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

test('expired owners cannot complete a replacement claim and pending claims are never evicted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-claim-fencing-'));
  let now = 1000;
  try {
    const store = await new DurableIdempotencyStore({ filePath: join(dir, 'journal'), clock: () => now, ttlMs: 100, maxRecords: 1 }).init();
    const old = await store.claim('request', 'same');
    await assert.rejects(store.claim('other', 'other'), { code: 'IDEMPOTENCY_CAPACITY' });
    assert.equal((await store.claim('request', 'same')).state, 'in_progress');
    now = 1200;
    const replacement = await store.claim('request', 'same');
    assert.notEqual(old.record.claimToken, replacement.record.claimToken);
    assert.equal(await store.completeClaim('request', 'same', old.record.claimToken, 'stale'), false);
    assert.equal(await store.completeClaim('request', 'same', replacement.record.claimToken, 'fresh'), true);
    await store.compact();
    const reopened = await new DurableIdempotencyStore({ filePath: join(dir, 'journal'), clock: () => now }).init();
    assert.equal((await reopened.claim('request', 'same')).record.response, 'fresh');
  } finally { await rm(dir, { recursive: true, force: true }); }
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
