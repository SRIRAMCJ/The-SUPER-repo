import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteWorkerAuthenticator } from '../src/index.js';

const key = Buffer.alloc(32, 7);

test('worker envelope authenticates a bounded request and rejects tamper and replay', () => {
  const client = new RemoteWorkerAuthenticator({ key, clock: () => 100_000, nonceFactory: () => 'nonce-1' });
  const worker = new RemoteWorkerAuthenticator({ key, clock: () => 100_005 });
  const envelope = client.sign({ requestId: 'req-1', nodeId: 'worker-1', payload: { capabilityId: 'repo.scan', input: { path: 'src' } } });
  const verified = worker.verify(structuredClone(envelope));
  assert.equal(verified.payload.capabilityId, 'repo.scan');
  awaitError(() => worker.verify(envelope), 'REMOTE_AUTH_REPLAY');
  const altered = structuredClone(envelope);
  altered.body.payload.input.path = 'secrets';
  awaitError(() => new RemoteWorkerAuthenticator({ key, clock: () => 100_005 }).verify(altered), 'REMOTE_AUTH_INVALID');
  awaitError(() => new RemoteWorkerAuthenticator({ key: Buffer.alloc(32, 8), clock: () => 100_005 }).verify(envelope), 'REMOTE_AUTH_INVALID');
});

test('worker envelope enforces freshness, active nonce capacity, and byte bounds', () => {
  let now = 100_000, nonce = 0;
  const client = new RemoteWorkerAuthenticator({ key, clock: () => now, nonceFactory: () => `nonce-${++nonce}`, maxSkewMs: 1000 });
  const worker = new RemoteWorkerAuthenticator({ key, clock: () => now, maxSkewMs: 1000, maxNonces: 1 });
  worker.verify(client.sign({ requestId: 'req-1', nodeId: 'worker-1', payload: {} }));
  awaitError(() => worker.verify(client.sign({ requestId: 'req-2', nodeId: 'worker-1', payload: {} })), 'REMOTE_AUTH_CAPACITY');
  now += 1001;
  worker.verify(client.sign({ requestId: 'req-3', nodeId: 'worker-1', payload: {} }));
  const stale = client.sign({ requestId: 'req-4', nodeId: 'worker-1', payload: {} });
  now += 1001;
  awaitError(() => worker.verify(stale), 'REMOTE_AUTH_EXPIRED');
  const small = new RemoteWorkerAuthenticator({ key, maxBytes: 512 });
  assert.throws(() => small.sign({ requestId: 'req-5', nodeId: 'worker-1', payload: { data: 'x'.repeat(600) } }), /byte limit/);
});

function awaitError(work, code) { assert.throws(work, { code }); }
