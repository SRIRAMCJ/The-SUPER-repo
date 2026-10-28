import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, unlink, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteWorkerAuthenticator, FileRemoteNonceStore, DurableIdempotencyStore, FileEventJournal,
  FileFailoverStore, UnixWorkerServer, UnixWorkerClient } from '../src/index.js';

test('killed worker after effect leaves request blocked across restart', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'super-worker-crash-'));
  const socketPath = path.join(directory, 'worker.sock');
  const key = Buffer.alloc(32, 17);
  let child, replacement;
  try {
    const leaseStore = new FileFailoverStore(path.join(directory, 'leases.json'));
    const lease = await leaseStore.claim('execution-1', 'node-1', 5000);
    const fence = { key: 'execution-1', epoch: lease.epoch, token: lease.token };
    child = spawn(process.execPath, [new URL('../fixtures/remote-worker-crash-fixture.js', import.meta.url).pathname, directory],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    assert.equal((await lines.next()).value, 'ready');
    const client = new UnixWorkerClient({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }), timeoutMs: 3000 });
    const request = { requestId: 'request-1', capabilityId: 'persist', input: { value: 1 }, fence };
    const pending = client.execute(request);
    pending.catch(() => {});
    assert.equal((await lines.next()).value, 'effect');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    await assert.rejects(pending, { code: 'REMOTE_CONNECTION_CLOSED' });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'effect.json'), 'utf8')), { value: 1 });
    await unlink(socketPath);
    await delay(1100);
    let repeated = 0;
    replacement = new UnixWorkerServer({ socketPath, nodeId: 'node-1', authenticator: new RemoteWorkerAuthenticator({ key }),
      nonceStore: new FileRemoteNonceStore({ filePath: path.join(directory, 'nonces.json') }),
      idempotencyStore: await new DurableIdempotencyStore({ filePath: path.join(directory, 'idempotency.jsonl'), ttlMs: 1000 }).init(),
      auditJournal: new FileEventJournal(path.join(directory, 'audit')),
      authorize: () => ({ allowed: true }),
      effectStore: leaseStore, effects: { persist: path.join(directory, 'effect.json') },
      handlers: { persist: async (input, context) => { repeated++; await context.writeEffect(input); } } });
    await replacement.start();
    await assert.rejects(client.execute(request), { code: 'REMOTE_RECOVERY_REQUIRED' });
    assert.equal(repeated, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'effect.json'), 'utf8')), { value: 1 });
  } finally {
    child?.kill('SIGKILL');
    await replacement?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
