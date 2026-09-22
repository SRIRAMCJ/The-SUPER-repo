import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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


test('mission store survives a fresh reader after every committed write', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-mission-durable-'));
  const file = path.join(directory, 'missions.json');
  const first = await new FileMissionStore(file).init();
  let record = await first.save({ missionId: 'mission/durable', missionExecutionId: 'exec/durable', type: 'vertical-mission', status: 'planning' });
  const second = await new FileMissionStore(file).init();
  assert.equal((await second.get('exec/durable')).version, record.version);

  record = await first.save({ ...record, status: 'executing' }, record.version);
  const third = await new FileMissionStore(file).init();
  const persisted = await third.get('exec/durable');
  assert.equal(persisted.status, 'executing');
  assert.equal(persisted.version, record.version);
});

test('mission store recovery lease survives process restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-mission-lease-'));
  const file = path.join(directory, 'missions.json');
  const first = await new FileMissionStore(file).init();
  const record = await first.save({ missionId: 'mission/lease', missionExecutionId: 'exec/lease', type: 'vertical-mission', status: 'executing' });
  const claimed = await first.claimRecovery(record.missionExecutionId, 'worker-a', 30000);
  assert.equal(claimed.recoveryLease.owner, 'worker-a');

  const restarted = await new FileMissionStore(file).init();
  const persisted = await restarted.get(record.missionExecutionId);
  assert.equal(persisted.recoveryLease.owner, 'worker-a');

  await assert.rejects(
    () => restarted.claimRecovery(record.missionExecutionId, 'worker-b', 30000),
    (error) => error.code === 'MISSION_RECOVERY_LEASE_HELD'
  );
});
