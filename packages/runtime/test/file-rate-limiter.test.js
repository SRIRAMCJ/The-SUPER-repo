import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileRateLimiter, RuntimeRequestGuard } from '../src/index.js';

const run = promisify(execFile);

test('fixed windows are shared across instances and reset after expiry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-file-rate-'));
  let now = 1000;
  const filePath = join(dir, 'windows.json');
  try {
    const a = new FileRateLimiter({ filePath, clock: () => now, maxRequests: 2, windowMs: 100 });
    const b = new FileRateLimiter({ filePath, clock: () => now, maxRequests: 2, windowMs: 100 });
    assert.equal((await a.consume('alice')).allowed, true);
    assert.equal((await b.consume('alice')).allowed, true);
    assert.deepEqual(await a.consume('alice'), { allowed: false, retryAfterMs: 100 });
    now += 100;
    assert.equal((await b.consume('alice')).allowed, true);
    assert.equal(b.snapshot().retainedPrincipals, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent processes cannot exceed the shared rate limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-file-rate-process-'));
  const filePath = join(dir, 'windows.json');
  try {
    const moduleUrl = new URL('../src/file-rate-limiter.js', import.meta.url).href;
    const script = `import {FileRateLimiter} from ${JSON.stringify(moduleUrl)}; console.log((await new FileRateLimiter({filePath:process.argv[1],maxRequests:3}).consume('same')).allowed)`;
    const results = await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, ['--input-type=module', '-e', script, filePath])));
    assert.equal(results.filter(({ stdout }) => stdout.trim() === 'true').length, 3);
    assert.equal(results.filter(({ stdout }) => stdout.trim() === 'false').length, 5);
    const restarted = new FileRateLimiter({ filePath, maxRequests: 3 });
    assert.equal((await restarted.consume('same')).allowed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('capacity and corrupt or missing observed state fail closed through the guard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'super-file-rate-closed-'));
  const filePath = join(dir, 'windows.json');
  try {
    const limiter = new FileRateLimiter({ filePath, maxPrincipals: 1 });
    const guard = new RuntimeRequestGuard({ rateLimiter: limiter });
    assert.equal((await guard.admit({ clientKey: 'alice' })).decision, 'accepted');
    assert.equal((await guard.admit({ clientKey: 'bob' })).error.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
    await writeFile(filePath, '{broken');
    assert.equal((await guard.admit({ clientKey: 'alice' })).error.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
    await rm(filePath);
    assert.equal((await guard.admit({ clientKey: 'alice' })).error.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
