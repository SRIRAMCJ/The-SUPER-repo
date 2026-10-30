import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UnixWorkerClient, UnixWorkerServer } from '../src/unix-worker-transport.js';
import { RemoteWorkerAuthenticator } from '../src/remote-worker-auth.js';
import { PostgresCoordinationStore } from '../src/postgres-coordination.js';
import { PostgresWorkerIdempotencyStore, PostgresWorkerAuditJournal } from '../src/postgres-worker-stores.js';

const url = process.env.SUPER_TEST_POSTGRES_URL;
test('killed PostgreSQL worker leaves a committed effect and blocks duplicate dispatch', { skip: !url, timeout: 15000 }, async () => {
  const { Pool } = await import('pg');
  const dir = await mkdtemp(path.join(tmpdir(), 'super-pg-crash-'));
  const pool = new Pool({ connectionString: url });
  const socketPath = path.join(dir, 'worker.sock');
  let child, replacement;
  try {
    const coordinator = await new PostgresCoordinationStore(pool).init();
    const effectKey = randomUUID();
    const lease = await coordinator.claim(effectKey, 'host-1', 5000, 'a'.repeat(64));
    const fence = { token: lease.token, epoch: lease.epoch };
    child = fork(new URL('../fixtures/postgres-worker-crash-fixture.js', import.meta.url), [], {
      env: { ...process.env, SUPER_TEST_SOCKET: socketPath }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', (code) => reject(new Error(`worker exited before ready: ${code}`))); });
    const client = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 11) }) });
    const requestId = randomUUID();
    const request = { requestId, capabilityId: 'commitThenCrash', input: { effectKey, fence } };
    await assert.rejects(client.execute(request));
    assert.equal((await coordinator.readEffect(effectKey)).value.value, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await unlink(socketPath);
    let reruns = 0;
    replacement = new UnixWorkerServer({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 11) }),
      nonceStore: coordinator, idempotencyStore: await new PostgresWorkerIdempotencyStore(pool, { ttlMs: 1000 }).init(),
      auditJournal: await new PostgresWorkerAuditJournal(pool).init(), authorize: () => ({ allowed: true }),
      handlers: { commitThenCrash: () => { reruns++; return 'unexpected'; } } });
    await replacement.start();
    await assert.rejects(client.execute(request), { code: 'REMOTE_RECOVERY_REQUIRED' });
    assert.equal(reruns, 0);
    assert.equal((await coordinator.readEffect(effectKey)).value.value, 1);
  } finally { child?.kill(); await replacement?.stop(); await pool.end(); await rm(dir, { recursive: true, force: true }); }
});
