import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { FileMissionStore } from '../src/mission-store.js';

test('file mission store persists and reloads mission state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'super-missions-'));
  try {
    const store = new FileMissionStore({ directory });
    const saved = await store.save({ missionId: 'm1', status: 'running' });
    assert.equal(saved.version, 1);
    assert.equal((await store.get('m1')).status, 'running');
    const updated = await store.save({ missionId: 'm1', status: 'succeeded' }, 1);
    assert.equal(updated.version, 2);
    assert.equal((await store.list()).length, 1);
    await assert.rejects(() => store.save({ missionId: 'm1', status: 'failed' }, 1), /version conflict/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
