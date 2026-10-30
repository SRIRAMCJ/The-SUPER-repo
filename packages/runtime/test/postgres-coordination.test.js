import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresCoordinationStore } from '../src/postgres-coordination.js';
import { RemoteWorkerAuthenticator } from '../src/remote-worker-auth.js';

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

test('PostgreSQL nonce ledger rejects concurrent replay across independent pools', { skip: !url }, async () => {
  const { Pool } = await import('pg');
  const pools = [new Pool({ connectionString: url }), new Pool({ connectionString: url })];
  try {
    const stores = await Promise.all(pools.map((pool) => new PostgresCoordinationStore(pool).init()));
    const nonce = randomUUID();
    const auth = new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 7), nonceFactory: () => nonce });
    const envelope = auth.sign({ requestId: randomUUID(), nodeId: 'node-1', payload: { capabilityId: 'echo' } });
    const results = await Promise.allSettled(stores.map((store) => auth.verifyWithStore(envelope, store)));
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.find(({ status }) => status === 'rejected').reason.code, 'REMOTE_AUTH_REPLAY');
  } finally { await Promise.all(pools.map((pool) => pool.end())); }
});

test('PostgreSQL nonce admission preserves capacity, replay priority and expiry under contention', { skip: !url }, async () => {
  const { Pool } = await import('pg');
  const schema = 'nonce_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url });
  const pools = [];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (let i = 0; i < 2; i++) pools.push(new Pool({ connectionString: url, max: 8, options: `-c search_path=${schema}` }));
    const stores = [];
    for (const pool of pools) stores.push(await new PostgresCoordinationStore(pool, { maxNonces: 4 }).init());
    const { rows: [time] } = await pools[0].query('SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now');
    const expiresAt = Number(time.now) + 60000;
    const nonces = Array.from({ length: 12 }, () => randomUUID());
    const decisions = await Promise.allSettled(nonces.map((nonce, i) => stores[i % 2].consume(nonce, expiresAt)));
    assert.equal(decisions.filter((r) => r.status === 'fulfilled').length, 4);
    assert.ok(decisions.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'REMOTE_AUTH_CAPACITY'));
    const winner = nonces[decisions.findIndex((r) => r.status === 'fulfilled')];
    await assert.rejects(stores[1].consume(winner, expiresAt), { code: 'REMOTE_AUTH_REPLAY' });
    await assert.rejects(stores[0].consume(randomUUID(), 0), { code: 'REMOTE_AUTH_EXPIRED' });
    assert.equal((await pools[1].query('SELECT count(*)::integer AS count FROM super_nonces')).rows[0].count, 4);
    await pools[0].query('UPDATE super_nonces SET expires_at=0');
    await stores[1].consume(randomUUID(), expiresAt);
    assert.equal((await pools[0].query('SELECT count(*)::integer AS count FROM super_nonces')).rows[0].count, 1);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
