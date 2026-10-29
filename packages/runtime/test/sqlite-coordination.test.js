import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteCoordinationStore } from '../src/sqlite-coordination.js';

const identity = 'a'.repeat(64);
test('SQLite lease and effect commit fence stale holders across connections and restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'super-sqlite-coordination-'));
  const file = path.join(dir, 'state.db');
  let first, second;
  try {
    first = new SqliteCoordinationStore(file);
    second = new SqliteCoordinationStore(file);
    const lease = first.claim('task', 'host-1', 1000, identity);
    assert.throws(() => second.claim('task', 'host-2', 1000, identity), { code: 'COORDINATOR_LEASE_HELD' });
    first.writeFencedEffect('task', lease, { count: 1 });
    assert.deepEqual(second.readEffect('task'), { value: { count: 1 }, epoch: 1 });
    first.close(); first = null;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const newer = second.claim('task', 'host-2', 1000, identity);
    assert.equal(newer.epoch, 2);
    assert.throws(() => second.writeFencedEffect('task', lease, { count: 2 }), { code: 'COORDINATOR_FENCE_REJECTED' });
    assert.throws(() => second.claim('task', 'host-3', 1000, 'b'.repeat(64)), { code: 'COORDINATOR_IDENTITY_CONFLICT' });
    second.writeFencedEffect('task', newer, { count: 3 });
    second.close(); second = new SqliteCoordinationStore(file);
    assert.deepEqual(second.readEffect('task'), { value: { count: 3 }, epoch: 2 });
  } finally { first?.close(); second?.close(); await rm(dir, { recursive: true, force: true }); }
});
