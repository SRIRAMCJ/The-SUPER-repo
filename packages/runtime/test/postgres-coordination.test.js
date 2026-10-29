import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresCoordinationStore } from '../src/postgres-coordination.js';

const url = process.env.SUPER_TEST_POSTGRES_URL;
test('PostgreSQL fences effects across independent pools', { skip: !url }, async () => {
  const { Pool } = await import('pg');
  const firstPool = new Pool({ connectionString: url, max: 2 });
  const secondPool = new Pool({ connectionString: url, max: 2 });
  try {
    const first = await new PostgresCoordinationStore(firstPool).init();
    const second = await new PostgresCoordinationStore(secondPool).init();
    const name = `test-${randomUUID()}`;
    const identity = 'a'.repeat(64);
    const lease = await first.claim(name, 'host-1', 1000, identity);
    await assert.rejects(second.claim(name, 'host-2', 1000, identity), { code: 'COORDINATOR_LEASE_HELD' });
    await first.writeFencedEffect(name, lease, { value: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const newer = await second.claim(name, 'host-2', 1000, identity);
    await assert.rejects(first.writeFencedEffect(name, lease, { value: 2 }), { code: 'COORDINATOR_FENCE_REJECTED' });
    await second.writeFencedEffect(name, newer, { value: 3 });
    assert.deepEqual(await first.readEffect(name), { value: { value: 3 }, epoch: 2 });
    await assert.rejects(first.claim(name, 'host-3', 1000, 'b'.repeat(64)), { code: 'COORDINATOR_IDENTITY_CONFLICT' });
  } finally { await firstPool.end(); await secondPool.end(); }
});
