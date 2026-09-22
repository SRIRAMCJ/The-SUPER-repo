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
