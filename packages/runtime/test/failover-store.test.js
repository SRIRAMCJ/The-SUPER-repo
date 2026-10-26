import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { FileFailoverStore } from '../src/failover-store.js';

async function temporary(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-failover-'));
  try { return await fn(path.join(directory, 'state.json')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('expired holder cannot commit or release after a new epoch claims leadership', () => temporary(async (file) => {
  const firstStore = new FileFailoverStore(file);
  const secondStore = new FileFailoverStore(file);
  const first = await firstStore.claim('runtime', 'a', 1000);
  await assert.rejects(secondStore.claim('runtime', 'b', 1000), { code: 'FAILOVER_LEASE_HELD' });
  await new Promise((resolve) => setTimeout(resolve, 1010));
  const second = await secondStore.claim('runtime', 'b', 1000);
  assert.equal(second.epoch, first.epoch + 1);
  assert.notEqual(second.token, first.token);
  await assert.rejects(firstStore.commit('runtime', first, { stale: true }), { code: 'FAILOVER_FENCE_REJECTED' });
  await assert.rejects(firstStore.release('runtime', first), { code: 'FAILOVER_FENCE_REJECTED' });
  const committed = await secondStore.commit('runtime', second, { winner: 'b' });
  assert.deepEqual(committed.result, { winner: 'b' });
  assert.deepEqual((await firstStore.inspect('runtime')).result, { winner: 'b' });
}));

test('cross-process concurrent claims elect one holder', () => temporary(async (file) => {
  const moduleUrl = new URL('../src/failover-store.js', import.meta.url).href;
  const script = `import { FileFailoverStore } from ${JSON.stringify(moduleUrl)}; const store = new FileFailoverStore(process.argv[1]); try { const claim = await store.claim('runtime', process.argv[2], 30000); console.log(JSON.stringify({ok:true,epoch:claim.epoch})); } catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); }`;
  const calls = Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, `owner-${i}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`claim process exited ${code}`)));
  }));
  const results = await Promise.all(calls);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => item.code === 'FAILOVER_LEASE_HELD').length, 5);
  assert.equal((await new FileFailoverStore(file).inspect('runtime')).epoch, 1);
}));

test('observed state disappearance fails closed', () => temporary(async (file) => {
  const store = new FileFailoverStore(file);
  await store.claim('runtime', 'a');
  await unlink(file);
  await assert.rejects(store.claim('runtime', 'b'), { code: 'FAILOVER_STORE_MISSING' });
  await assert.rejects(new FileFailoverStore(file).claim('runtime', 'b'), { code: 'FAILOVER_STORE_MISSING' });
}));

test('an older state file acquires an initialization marker before disappearance', () => temporary(async (file) => {
  await writeFile(file, JSON.stringify([{ schemaVersion: '0.1.0', name: 'runtime', owner: 'a', token: null,
    epoch: 8, version: 0, expiresAt: 0, result: null }]));
  assert.equal((await new FileFailoverStore(file).inspect('runtime')).epoch, 8);
  await unlink(file);
  await assert.rejects(new FileFailoverStore(file).claim('runtime', 'b'), { code: 'FAILOVER_STORE_MISSING' });
}));

test('corrupted lease metadata cannot be reclaimed', () => temporary(async (file) => {
  await writeFile(file, JSON.stringify([{ schemaVersion: '0.1.0', name: 'runtime', owner: 'a', token: 'old', epoch: 1, version: 0, expiresAt: 'tomorrow' }]));
  await assert.rejects(new FileFailoverStore(file).claim('runtime', 'b'), { code: 'FAILOVER_STORE_CORRUPT' });
}));

test('file effect commits under the lease lock and rejects a stale worker after takeover', () => temporary(async (file) => {
  const firstStore = new FileFailoverStore(file);
  const secondStore = new FileFailoverStore(file);
  const effect = path.join(path.dirname(file), 'effect.json');
  const first = await firstStore.claim('runtime', 'a', 1000);
  await firstStore.writeFencedJson('runtime', first, effect, { owner: 'a' });
  assert.deepEqual(JSON.parse(await readFile(effect, 'utf8')), { owner: 'a' });
  await new Promise((resolve) => setTimeout(resolve, 1010));
  const second = await secondStore.claim('runtime', 'b', 1000);
  await assert.rejects(firstStore.writeFencedJson('runtime', first, effect, { owner: 'stale' }), { code: 'FAILOVER_FENCE_REJECTED' });
  await secondStore.writeFencedJson('runtime', second, effect, { owner: 'b' });
  assert.deepEqual(JSON.parse(await readFile(effect, 'utf8')), { owner: 'b' });
  assert.throws(() => secondStore.writeFencedJson('runtime', second, file, {}), TypeError);
}));
