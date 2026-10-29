import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresWorkerIdempotencyStore, PostgresWorkerAuditJournal } from '../src/postgres-worker-stores.js';
import { PostgresCoordinationStore } from '../src/postgres-coordination.js';
import { RemoteWorkerAuthenticator } from '../src/remote-worker-auth.js';
import { UnixWorkerServer, UnixWorkerClient } from '../src/unix-worker-transport.js';

const url = process.env.SUPER_TEST_POSTGRES_URL;
test('PostgreSQL worker stores single-flight and audit across two pools', { skip: !url }, async () => {
  const { Pool } = await import('pg');
  const pools = [new Pool({ connectionString: url }), new Pool({ connectionString: url })];
  try {
    const stores = [];
    for (const pool of pools) stores.push({ requests: await new PostgresWorkerIdempotencyStore(pool).init(), audit: await new PostgresWorkerAuditJournal(pool).init() });
    const key = randomUUID(), fingerprint = 'fingerprint';
    const decisions = await Promise.all(stores.map(({ requests }) => requests.claim(key, fingerprint)));
    assert.deepEqual(decisions.map((d) => d.state).sort(), ['claimed', 'in_progress']);
    const owner = decisions.findIndex((d) => d.state === 'claimed');
    const claim = decisions[owner];
    assert.equal(await stores[owner].requests.completeClaim(key, fingerprint, claim.record.claimToken, { result: 42 }), true);
    assert.equal(await stores[owner].requests.completeClaim(key, fingerprint, 'wrong', { result: 0 }), false);
    assert.deepEqual((await stores[1-owner].requests.claim(key, fingerprint)).record.response, { result: 42 });
    assert.equal((await stores[1-owner].requests.claim(key, 'other')).state, 'conflict');
    const events = await Promise.all(stores.map(({ audit }) => audit.append({ type: 'worker.test', key })));
    assert.equal(new Set(events.map((e) => e.sequence)).size, 2);
    const replay = await stores[0].audit.replay({ afterSequence: events[0].sequence - 1 });
    assert.ok(replay.events.some((entry) => entry.event.key === key));
    const sequence = events[0].sequence;
    const { rows: [saved] } = await pools[0].query('SELECT event FROM super_worker_audit WHERE sequence=$1', [sequence]);
    try {
      await pools[0].query('UPDATE super_worker_audit SET event=$2::jsonb WHERE sequence=$1', [sequence, JSON.stringify({ ...saved.event, type: 'tampered' })]);
      await assert.rejects(stores[1].audit.replay(), { code: 'AUDIT_CORRUPT' });
    } finally { await pools[0].query('UPDATE super_worker_audit SET event=$2::jsonb WHERE sequence=$1', [sequence, JSON.stringify(saved.event)]); }
  } finally { await Promise.all(pools.map((pool) => pool.end())); }
});

test('expired PostgreSQL claims require token-bound operator reconciliation', { skip: !url }, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });
  try {
    const store = await new PostgresWorkerIdempotencyStore(pool, { ttlMs: 1000 }).init();
    const key = randomUUID();
    const claim = await store.claim(key, 'fingerprint');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await store.claim(key, 'fingerprint')).state, 'recovery_required');
    assert.equal(await store.reconcileClaim(key, 'fingerprint', 'wrong', { result: 1 }, { reason: 'effect verified' }), false);
    assert.equal(await store.reconcileClaim(key, 'fingerprint', claim.record.claimToken, { result: 2 }, { reason: 'effect verified' }), true);
    assert.deepEqual((await store.claim(key, 'fingerprint')).record.response, { result: 2 });
  } finally { await pool.end(); }
});

test('governed Unix worker dispatch uses PostgreSQL nonce, audit, and idempotency stores', { skip: !url }, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });
  const directory = await mkdtemp(path.join(tmpdir(), 'super-postgres-worker-'));
  let server;
  try {
    const socketPath = path.join(directory, 'worker.sock');
    const key = Buffer.alloc(32, 8);
    let calls = 0;
    server = new UnixWorkerServer({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }),
      nonceStore: await new PostgresCoordinationStore(pool).init(),
      idempotencyStore: await new PostgresWorkerIdempotencyStore(pool).init(),
      auditJournal: await new PostgresWorkerAuditJournal(pool).init(),
      authorize: () => ({ allowed: true }), handlers: { echo: (input) => { calls++; return input.value; } } });
    await server.start();
    const client = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }) });
    const requestId = randomUUID();
    assert.equal(await client.execute({ requestId, capabilityId: 'echo', input: { value: 42 } }), 42);
    assert.equal(await client.execute({ requestId, capabilityId: 'echo', input: { value: 42 } }), 42);
    assert.equal(calls, 1);
  } finally { await server?.stop(); await pool.end(); await rm(directory, { recursive: true, force: true }); }
});
