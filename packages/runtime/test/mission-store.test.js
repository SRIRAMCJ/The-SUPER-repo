import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FileMissionStore } from '../src/mission-store.js';

test('mission store persists records and enforces optimistic versions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-mission-store-'));
  const file = path.join(directory, 'missions.json');
  const first = await new FileMissionStore(file).init();
  const created = await first.save({ missionId: 'mission/1', type: 'vertical-mission', status: 'planning' });
  assert.equal(created.version, 0);

  const second = await new FileMissionStore(file).init();
  assert.equal((await second.get('mission/1')).status, 'planning');
  const updated = await second.save({ missionId: 'mission/1', type: 'vertical-mission', status: 'executing' }, 0);
  assert.equal(updated.version, 1);

  await assert.rejects(
    () => second.save({ missionId: 'mission/1', type: 'vertical-mission', status: 'failed' }, 0),
    (error) => error.code === 'MISSION_STATE_CONFLICT'
  );
});

test('independent writers preserve records and reject stale versions', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-mission-writers-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const file = path.join(directory, 'missions.json');
  const a = await new FileMissionStore(file).init();
  const b = await new FileMissionStore(file).init();
  await Promise.all([a.save({ missionId: 'a' }), b.save({ missionId: 'b' })]);
  assert.deepEqual((await new FileMissionStore(file).list()).map((r) => r.missionId).sort(), ['a', 'b']);
  const stale = await a.get('a');
  await b.save({ ...stale, status: 'updated' }, stale.version);
  await assert.rejects(a.save({ ...stale, status: 'lost' }, stale.version), (error) => error.code === 'MISSION_STATE_CONFLICT');
  assert.equal((await a.get('a')).status, 'updated');
});

test('recovery claims fence stale workers even when the owner name repeats', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-mission-fencing-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const file = path.join(directory, 'missions.json');
  const a = await new FileMissionStore(file).init();
  const b = await new FileMissionStore(file).init();
  const initial = await a.save({ missionId: 'mission', missionExecutionId: 'exec', status: 'executing' });
  const old = await a.claimRecovery('exec', 'worker', 1000);
  assert.equal(old.version, initial.version + 1);
  await assert.rejects(b.claimRecovery('exec', 'worker', 1000), (error) => error.code === 'MISSION_RECOVERY_LEASE_HELD');
  const now = Date.now;
  Date.now = () => now() + 2000;
  let replacement;
  try { replacement = await b.claimRecovery('exec', 'worker', 30000); }
  finally { Date.now = now; }
  assert.notEqual(old.recoveryLease.token, replacement.recoveryLease.token);
  await assert.rejects(a.save({ ...old, status: 'failed' }, old.version), (error) => error.code === 'MISSION_STATE_CONFLICT');
  await assert.rejects(a.releaseRecovery('exec', old.recoveryLease.token), (error) => error.code === 'MISSION_RECOVERY_LEASE_HELD');
  const finished = await b.save({ ...replacement, status: 'succeeded' }, replacement.version);
  const released = await b.releaseRecovery('exec', replacement.recoveryLease.token);
  assert.equal(released.version, finished.version + 1);
  assert.equal((await new FileMissionStore(file).get('exec')).status, 'succeeded');
});

test('separate processes serialize mission writes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-mission-processes-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const file = path.join(directory, 'missions.json');
  const moduleUrl = new URL('../src/mission-store.js', import.meta.url).href;
  const script = `import { FileMissionStore } from ${JSON.stringify(moduleUrl)}; await new FileMissionStore(process.argv[1]).save({ missionId: process.argv[2] });`;
  const run = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, id], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all(Array.from({ length: 4 }, (_, index) => run('process-' + index)));
  assert.deepEqual((await new FileMissionStore(file).list()).map((r) => r.missionId).sort(),
    ['process-0', 'process-1', 'process-2', 'process-3']);
});
