import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileFailoverStore } from '../src/failover-store.js';
import { RuntimeFailoverKernel } from '../src/failover.js';

async function fixture(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-failover-kernel-'));
  try { return await fn(path.join(directory, 'state.json')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const supervisor = (state) => ({ evaluate: async () => ({ state }) });
const kernel = (file, recover, owner = 'worker', options = {}) => new RuntimeFailoverKernel({
  supervisor: supervisor('failed'), store: new FileFailoverStore(file), recover, owner,
  leaseMs: 1000, renewEveryMs: 100, timeoutMs: 500, ...options
});

test('healthy state skips recovery; stable incident commits once while new incident recovers', () => fixture(async (file) => {
  let calls = 0;
  const recover = async ({ fence }) => { calls++; await fence.assertCurrent(); return { calls }; };
  const healthy = kernel(file, recover, 'healthy', { supervisor: supervisor('healthy') });
  assert.equal((await healthy.attempt('gateway', 'one')).status, 'skipped');
  const instance = kernel(file, recover);
  assert.equal((await instance.attempt('gateway', 'one')).status, 'succeeded');
  assert.equal((await instance.attempt('gateway', 'one')).status, 'completed');
  assert.equal((await instance.attempt('gateway', 'two')).status, 'succeeded');
  assert.equal(calls, 2);
}));

test('concurrent kernels elect one recovery holder', () => fixture(async (file) => {
  let entered;
  const running = new Promise((resolve) => { entered = resolve; });
  let finish;
  const hold = new Promise((resolve) => { finish = resolve; });
  const first = kernel(file, async () => { entered(); await hold; return 'done'; }, 'a');
  const second = kernel(file, async () => { throw new Error('duplicate recovery'); }, 'b');
  const pending = first.attempt('gateway', 'incident');
  await running;
  assert.equal((await second.attempt('gateway', 'incident')).status, 'contended');
  finish();
  assert.equal((await pending).status, 'succeeded');
  assert.equal((await second.attempt('gateway', 'incident')).status, 'completed');
}));

test('failed heartbeat fences recovery and prevents state commit', () => fixture(async (file) => {
  const store = new FileFailoverStore(file);
  const instance = kernel(file, async () => new Promise(() => {}), 'a', {
    store: { inspect: (...args) => store.inspect(...args), claim: (...args) => store.claim(...args),
      renew: async () => { throw new Error('renewal lost'); }, commit: (...args) => store.commit(...args),
      release: (...args) => store.release(...args) }
  });
  const result = await instance.attempt('gateway', 'incident');
  assert.equal(result.status, 'fenced');
  assert.equal((await store.inspect(JSON.stringify(['gateway', 'incident']))).result, null);
}));

test('timeout returns promptly and an incident can be retried', () => fixture(async (file) => {
  const instance = kernel(file, async () => new Promise(() => {}), 'a', { timeoutMs: 150 });
  const result = await instance.attempt('gateway', 'incident');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'RECOVERY_TIMEOUT');
  assert.equal((await kernel(file, async () => 'ok', 'b').attempt('gateway', 'incident')).status, 'succeeded');
}));

test('parent abort returns promptly without committing recovery', () => fixture(async (file) => {
  const controller = new AbortController();
  const instance = kernel(file, async () => new Promise(() => {}), 'a');
  setTimeout(() => controller.abort(), 75);
  const result = await instance.attempt('gateway', 'incident', { signal: controller.signal });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'RECOVERY_CANCELLED');
}));
